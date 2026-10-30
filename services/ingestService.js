/**
 * ingestService — the single write path for every source.
 *
 * All four ingesters (manual, slack, gmail, google docs) previously duplicated
 * the same extract → save → embed → vectorise → graph sequence, which meant a
 * fix had to be applied four times. They now all call ingestDocument().
 *
 * Storage is best-effort per layer: if ChromaDB or Neo4j is down the document
 * is still saved and still keyword-searchable, and the response reports which
 * layers succeeded.
 */

const Document = require('../models/Document');
const { extractReasoning, getEmbedding } = require('./aiService');
const { addToChroma, deleteFromChroma } = require('./chromaService');

const MAX_CONTENT_CHARS = Number(process.env.INGEST_MAX_CHARS || 8000);
const NO_DECISION = 'No decision';

/**
 * How many superseded decisions are retained per document.
 *
 * Decisions change a handful of times over an artefact's life; the cap exists
 * so a pathological edit loop cannot grow a document without bound, not
 * because twenty changes is expected.
 */
const DECISION_HISTORY_MAX = 20;

/** A decision worth remembering. The "No decision" sentinel is not one. */
function isRealDecision(text) {
  const t = String(text ?? '').trim();
  return Boolean(t) && t !== NO_DECISION;
}

/**
 * Append a superseded decision to the history, oldest first.
 *
 * Pure so the behaviour can be pinned down in smoke tests without a database:
 * consecutive duplicates are dropped (re-saving the same decision must not grow
 * the list) and the list is capped, dropping the OLDEST entries so the most
 * recent changes - the ones a question is most likely about - survive.
 */
function appendSuperseded(history, entry) {
  const list = Array.isArray(history) ? history.filter((h) => h && isRealDecision(h.text)) : [];
  const text = String(entry?.text ?? '').trim();
  if (!isRealDecision(text)) return list;

  const last = list[list.length - 1];
  if (last && String(last.text).trim() === text) return list;

  const next = [...list, { ...entry, text }];
  return next.length > DECISION_HISTORY_MAX ? next.slice(next.length - DECISION_HISTORY_MAX) : next;
}

class IngestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

function normaliseContent(content) {
  const text = String(content ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new IngestError('EMPTY_CONTENT', 'content is empty after trimming');
  if (text.length > MAX_CONTENT_CHARS) {
    return { text: text.slice(0, MAX_CONTENT_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

function requireFields({ source, title }) {
  if (!source || !String(source).trim()) throw new IngestError('MISSING_SOURCE', 'source is required');
  if (!title || !String(title).trim()) throw new IngestError('MISSING_TITLE', 'title is required');
  if (String(title).length > 300) throw new IngestError('TITLE_TOO_LONG', 'title must be 300 characters or fewer');
}

async function findExisting(dedupQuery) {
  if (!dedupQuery || !Object.keys(dedupQuery).length) return null;
  return Document.findOne(dedupQuery);
}

/**
 * Write a document through every storage layer.
 *
 * @param {object}   opts
 * @param {string}   opts.source            gmail | slack | google_docs | manual | transcript
 * @param {string}   opts.title
 * @param {string}   opts.content           raw text (trimmed/truncated internally)
 * @param {object}   [opts.metadata]        provider-specific ids used for dedup
 * @param {object}   [opts.dedupQuery]      Mongo query identifying an existing doc
 * @param {boolean}  [opts.replaceExisting] update in place instead of creating a duplicate
 * @param {boolean}  [opts.skipExtraction]  reuse previously extracted fields
 * @param {object}   [opts.extracted]       pre-computed extraction when skipExtraction
 */
async function ingestDocument({
  source,
  title,
  content,
  metadata = {},
  dedupQuery = null,
  replaceExisting = false,
  skipExtraction = false,
  extracted: preExtracted = null,
}) {
  requireFields({ source, title });
  const { text, truncated } = normaliseContent(content);

  const cleanSource = String(source).trim();
  const cleanTitle = String(title).trim();

  const existing = await findExisting(dedupQuery);
  if (existing && !replaceExisting) {
    return {
      docId: String(existing._id),
      created: false,
      duplicate: true,
      skipped: 'already_ingested',
      tags: existing.tags || [],
    };
  }

  const extracted =
    skipExtraction && preExtracted
      ? preExtracted
      : await extractReasoning(text, cleanSource);

  // ── Decision history ─────────────────────────────────────
  // Built BEFORE the save, because both places that overwrite `decision` below
  // would otherwise discard the value they are replacing.
  const selfId = existing?._id || null;
  const nowIso = new Date().toISOString();
  let decisionHistory = existing && replaceExisting && Array.isArray(existing.decisionHistory)
    ? [...existing.decisionHistory]
    : [];

  // 1. In-place update: the previous decision of THIS artefact is superseded.
  if (existing && replaceExisting && isRealDecision(existing.decision) && existing.decision !== extracted.decision) {
    decisionHistory = appendSuperseded(decisionHistory, {
      text: existing.decision,
      summary: existing.summary || '',
      decidedAt: nowIso,
    });
  }

  // 2. Threaded sources (Gmail today, Slack threads when they carry a
  //    threadId): a follow-up item that reaches a NEW decision records what
  //    the thread's previous item had decided, attributed to that item.
  const threadId = metadata?.threadId ? String(metadata.threadId).trim() : '';
  let threadPrev = null;
  if (threadId) {
    threadPrev = await Document.findOne({
      source: cleanSource,
      'metadata.threadId': threadId,
      ...(selfId ? { _id: { $ne: selfId } } : {}),
    })
      .sort({ createdAt: -1 })
      .select('title decision summary updatedAt createdAt');
  }
  if (
    threadPrev &&
    isRealDecision(threadPrev.decision) &&
    threadPrev.decision !== extracted.decision
  ) {
    decisionHistory = appendSuperseded(decisionHistory, {
      text: threadPrev.decision,
      summary: threadPrev.summary || '',
      decidedAt: (threadPrev.updatedAt || threadPrev.createdAt || new Date()).toISOString(),
      fromDocId: String(threadPrev._id),
      fromTitle: threadPrev.title || '',
    });
  }

  // ── Mongo ───────────────────────────────────────────────
  let doc;
  try {
    if (existing && replaceExisting) {
      // findById() returns a Query, not a document. Without the await, every
      // assignment below writes to the Query and `doc.save` does not exist —
      // which is exactly how Google Docs re-sync died with
      // "doc.save is not a function". gdocs always passes replaceExisting, so
      // this branch is its only update path.
      doc = await Document.findById(existing._id);
      doc.source = cleanSource;
      doc.title = cleanTitle;
      doc.rawContent = text;
      doc.summary = extracted.summary;
      doc.decision = extracted.decision;
      doc.reasoning = extracted.reasoning;
      doc.tags = extracted.tags;
      doc.degraded = extracted.degraded || null;
      doc.decisionHistory = decisionHistory;
      doc.metadata = { ...(existing.metadata?.toObject?.() || existing.metadata || {}), ...metadata };
      await doc.save();
    } else {
      doc = new Document({
        source: cleanSource,
        title: cleanTitle,
        rawContent: text,
        summary: extracted.summary,
        decision: extracted.decision,
        reasoning: extracted.reasoning,
        tags: extracted.tags,
        degraded: extracted.degraded || null,
        decisionHistory,
        metadata,
      });
      await doc.save();
    }
  } catch (err) {
    // The unique dedup indexes are the real guard against double-insert: a cron
    // tick and a manual fetch can interleave between the findOne above and this
    // save. Losing that race is a normal outcome, not an error.
    if (err.code === 11000) {
      console.warn(`[ingest] dedup race lost for ${cleanSource}; keeping the stored copy`);
      return {
        docId: String(existing?._id || ''),
        created: false,
        duplicate: true,
        skipped: 'concurrent_ingest',
        tags: existing?.tags || [],
        layers: { mongo: true, chroma: false, neo4j: false },
      };
    }
    throw err;
  }

  const docId = doc._id.toString();
  const layers = { mongo: true, chroma: false, neo4j: false };

  // ── ChromaDB (lazy require keeps the graph layer optional) ──
  const embedding = await getEmbedding(text, { task: 'document' });
  if (embedding.length > 0) {
    layers.chroma = await addToChroma(docId, embedding, text, {
      source: cleanSource,
      title: cleanTitle,
      docId,
    });
  } else {
    console.warn(`[ingest] no embedding produced for ${docId}; keyword search only`);
  }

  // ── Neo4j ───────────────────────────────────────────────
  try {
    const { storeDocumentNode } = require('./neo4jService');
    layers.neo4j = await storeDocumentNode(docId, cleanTitle, cleanSource, extracted.decision, extracted.tags, {
      history: decisionHistory,
      previousDocId: threadPrev ? String(threadPrev._id) : null,
    });
  } catch (err) {
    console.warn(`[ingest] graph write skipped for ${docId}: ${err.message}`);
  }

  return {
    docId,
    created: !existing,
    duplicate: false,
    replaced: Boolean(existing && replaceExisting),
    truncated,
    summary: extracted.summary,
    decision: extracted.decision,
    // The last entry is the immediately-preceding decision; callers surface it
    // as "previously" without walking the whole chain.
    previousDecision: decisionHistory.length ? decisionHistory[decisionHistory.length - 1].text : null,
    decisionHistory,
    reasoning: extracted.reasoning,
    tags: extracted.tags,
    degraded: extracted.degraded || null,
    layers,
  };
}

/** Remove a document from Mongo, the vector index, and the knowledge graph. */
async function removeDocument(docId) {
  const doc = await Document.findByIdAndDelete(docId);
  if (!doc) return false;
  try {
    await deleteFromChroma(docId);
  } catch (err) {
    console.warn(`[ingest] vector cleanup failed for ${docId}: ${err.message}`);
  }
  try {
    const { deleteDocumentNode } = require('./neo4jService');
    await deleteDocumentNode(docId);
  } catch (err) {
    // The graph is a derived index; a stale node is recoverable, a failed
    // delete request is not worth failing the API call over.
    console.warn(`[ingest] graph cleanup failed for ${docId}: ${err.message}`);
  }
  return true;
}

module.exports = {
  ingestDocument,
  removeDocument,
  IngestError,
  MAX_CONTENT_CHARS,
  NO_DECISION,
  // Pure helpers, exported so test_smoke.js can pin the history rules without
  // a database or an AI call.
  DECISION_HISTORY_MAX,
  isRealDecision,
  appendSuperseded,
};
