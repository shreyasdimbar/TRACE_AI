const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Document = require('../models/Document');

const { getEmbedding, answerQuestion, AiError } = require('../services/aiService');
const { queryChroma, status: chromaStatus } = require('../services/chromaService');
const neo4j = require('../services/neo4jService');
const { requireAuth } = require('./auth');

const TOP_K = Number(process.env.ASK_TOP_K || 6);
const GRAPH_EXPANSION = Number(process.env.ASK_GRAPH_EXPANSION || 3);
const NO_DECISION = 'No decision';

/**
 * Detect an explicit request for the latest decision across the archive.
 *
 * These are temporal lookup questions, not semantic-similarity questions. A
 * vector search for "what is the latest decision?" can return any historically
 * similar decision; rank by the document's update/creation time instead. The
 * answer context already carries its immediately-preceding decision when one
 * is recorded.
 */
function isLatestDecisionQuestion(input) {
  const text = String(input || '').toLowerCase();
  const asksLatest = /\b(latest|most\s+recent|current)\b/.test(text);
  const asksDecision = /\b(decision|decided|resolution|resolved)\b/.test(text);
  return asksLatest && asksDecision;
}

/**
 * Greetings and smalltalk are not research questions.
 *
 * They used to be sent through retrieval like anything else. Vector search
 * always returns its nearest neighbours, so "hi" produced six unrelated
 * documents, the model correctly found no answer among them, and the user got
 * the canned refusal roughly eight seconds and one Gemini call later. Answering
 * these directly is both instant and honest about what the system does.
 *
 * Matching is two-stage: a bare opener ("hi"), or an opener plus a short filler
 * phrase ("hi there", "hey how are you"). The filler list is deliberately
 * closed -- a remainder that is not on it falls through to real retrieval, so
 * "hi, what is the leave policy?" is still answered from the archive.
 */
const OPENER = new RegExp(
  String.raw`^(?:` +
    String.raw`hi+|hello+|hey+|yo|hiya|hola|howdy|sup|greetings|` + // salutations
    String.raw`thanks?|thank\s*you|thx|cheers|` + // gratitude
    String.raw`ok(?:aye?)?|k|cool|nice|great|test|ping|` + // acknowledgements
    String.raw`what'?s\s+up|` + // smalltalk opener (sup/howdy already above)
    String.raw`who\s+are\s+you|what\s+can\s+you\s+do|help` + // identity / capability
    String.raw`)$`,
  'i'
);

const FILLER = new RegExp(
  String.raw`^(?:` +
    String.raw`there|ya|you|team|all|everyone|folks|chat|friend|mate|` +
    String.raw`how\s+(?:are\s+you|is\s+it\s+going|goes)|howdy|what'?s\s+up|` +
    String.raw`a\s+lot|so\s+much|in\s+advance|again` +
    String.raw`)[\s!.?]*$`,
  'i'
);

function isSmalltalk(input) {
  const text = input.trim();
  if (OPENER.test(text)) return true;
  const split = text.match(/^(\S+)\s+(.+)$/);
  return Boolean(split && OPENER.test(split[1]) && FILLER.test(split[2]));
}

const SMALLTALK_REPLY =
  "Hi — I'm Trace.AI, your organizational memory.\n\n" +
  'I answer strictly from what is indexed here: Gmail threads, Slack channels, ' +
  'Google Docs and meeting transcripts. I do not use outside knowledge.\n\n' +
  'Try one of these:\n' +
  '  · What decisions were made recently?\n' +
  '  · Summarize the latest emails\n' +
  '  · What is the team working on?\n' +
  '  · Any action items from Slack?';

const isObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));

function uniqueDocs(docs) {
  const seen = new Set();
  return docs.filter((d) => {
    const id = String(d._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Lexical fallback ranked by Mongo's text score. */
async function keywordSearch(question, limit) {
  const hasTerms = String(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2).length > 0;

  if (!hasTerms) {
    return Document.find().sort({ createdAt: -1 }).limit(limit).lean();
  }

  try {
    return await Document.aggregate([
      { $match: { $text: { $search: question } } },
      { $addFields: { score: { $meta: 'textScore' } } },
      { $sort: { score: -1, createdAt: -1 } },
      { $limit: limit },
    ]);
  } catch (err) {
    // A missing text index makes $text unusable; fall back to recency.
    console.warn(`[ask] keyword search unavailable (${err.message}); using recency`);
    return Document.find().sort({ createdAt: -1 }).limit(limit).lean();
  }
}

/**
 * Retrieve candidates, then decide whether we actually have a grounded answer.
 *
 * The previous version's final fallback fed four arbitrary recent documents to
 * the model whenever both semantic and keyword search missed, which produced
 * confident answers built from unrelated content. We now return an explicit
 * "no evidence" response instead of guessing.
 */
async function retrieve(question) {
  const strategy = { vector: false, keyword: false, graph: false };

  // A global "latest decision" request has a deterministic answer: the newest
  // updated document with an actual decision. Do not let vector similarity pick
  // a different, older item, or return the no-evidence response just because
  // the question omitted a document title. The selected document's decision
  // history is passed through to buildContext() and the citation payload.
  if (isLatestDecisionQuestion(question)) {
    const latestDecision = await Document.find({
      decision: { $exists: true, $nin: ['', NO_DECISION, null] },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(1)
      .lean();
    return {
      docs: latestDecision,
      strategy: { ...strategy, keyword: latestDecision.length > 0 },
    };
  }

  let docs = [];

  const embedding = await getEmbedding(question, { task: 'query' });
  if (embedding.length) {
    const hits = await queryChroma(embedding, TOP_K);
    const ids = hits.map((h) => h.docId).filter(isObjectId);
    if (ids.length) {
      docs = await Document.find({ _id: { $in: ids } }).lean();
      // Preserve vector ordering — it is relevance-ordered already.
      const rank = new Map(hits.map((h, i) => [String(h.docId), i]));
      docs.sort((a, b) => rank.get(String(a._id)) - rank.get(String(b._id)));
      strategy.vector = true;
    }
  }

  if (docs.length < 2) {
    const keywordDocs = await keywordSearch(question, TOP_K);
    if (keywordDocs.length) {
      docs = uniqueDocs([...docs, ...keywordDocs]).slice(0, TOP_K);
      strategy.keyword = true;
    }
  }

  // Widen via the knowledge graph: documents that share tags with the best
  // hits, or that arrived with the same decision.
  if (docs.length && GRAPH_EXPANSION > 0) {
    const seed = docs[0];
    const tagNames = (seed.tags || []).filter(Boolean);
    if (tagNames.length) {
      const related = await neo4j.getRelatedDocuments(tagNames, {
        excludeIds: docs.map((d) => String(d._id)),
        limit: GRAPH_EXPANSION,
      });
      const relatedIds = related.map((r) => r.docId).filter(isObjectId);
      if (relatedIds.length) {
        const extra = await Document.find({ _id: { $in: relatedIds } }).lean();
        if (extra.length) {
          docs = uniqueDocs([...docs, ...extra]).slice(0, TOP_K + GRAPH_EXPANSION);
          strategy.graph = true;
        }
      }
    }

    if (seed.decision && seed.decision !== NO_DECISION) {
      const twins = await neo4j.getDocumentsSharingDecision(seed.decision, { limit: 2 });
      const twinIds = twins.map((t) => t.docId).filter(isObjectId);
      if (twinIds.length) {
        const extra = await Document.find({ _id: { $in: twinIds } }).lean();
        if (extra.length) {
          docs = uniqueDocs([...docs, ...extra]).slice(0, TOP_K + GRAPH_EXPANSION + 2);
          strategy.graph = true;
        }
      }
    }
  }

  return { docs, strategy };
}

// ── POST /api/ask ───────────────────────────────────────── */
router.post('/', requireAuth, async (req, res, next) => {
  const question = String(req.body?.question || '').trim();

  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (question.length > 2000) {
    return res.status(400).json({ error: 'question must be 2000 characters or fewer' });
  }

  const startedAt = Date.now();

  try {
    // Answer greetings without touching retrieval or the model.
    if (isSmalltalk(question)) {
      return res.json({
        answer: SMALLTALK_REPLY,
        sources: [],
        grounded: false,
        retrieved: 0,
        strategy: { vector: false, keyword: false, graph: false },
        degraded: { chroma: chromaStatus() },
        tookMs: Date.now() - startedAt,
      });
    }

    const total = await Document.estimatedDocumentCount();
    if (total === 0) {
      return res.json({
        answer: 'There is nothing indexed yet. Ingest some data first, then ask again.',
        sources: [],
        grounded: false,
        retrieved: 0,
        strategy: { vector: false, keyword: false, graph: false },
        degraded: { chroma: chromaStatus() },
      });
    }

    const { docs, strategy } = await retrieve(question);

    // No evidence at all: say so instead of inventing an answer.
    if (!docs.length) {
      return res.json({
        answer:
          'I could not find anything relevant to that in the indexed sources. ' +
          'Try different keywords, or ingest more data.',
        sources: [],
        grounded: false,
        retrieved: 0,
        strategy,
        degraded: { chroma: chromaStatus() },
        tookMs: Date.now() - startedAt,
      });
    }

    const { answer, sources } = await answerQuestion(question, docs);

    // If the model says it could not find it, do not present citations as
    // proof. An abstention with a wall of sources underneath reads as "here is
    // your answer and also nine documents you did not ask for" — so the source
    // list goes empty to match the answer.
    const abstained = /could not find|not (?:present|in) the (?:indexed|context|provided)/i.test(answer);
    const payload = abstained ? [] : sources;

    res.json({
      answer,
      sources: payload,
      grounded: !abstained,
      // `retrieved` means documents pulled into context, NOT documents cited.
      // Source filtering shrinks the citation list, so reporting that count
      // here would hide how much context was actually searched.
      retrieved: docs.length,
      strategy,
      degraded: { chroma: chromaStatus(), neo4j: neo4j.status() },
      tookMs: Date.now() - startedAt,
    });
  } catch (err) {
    if (err instanceof AiError) {
      // Gemini gave up before answering (no reply within the ask budget). Show the
      // user a friendly "too much traffic, try again" reply instead of a raw error,
      // so the chat renders it as the answer rather than an error card.
      if (err.code === 'UPSTREAM_TIMEOUT' || err.code === 'UPSTREAM_UNAVAILABLE') {
        return res.json({
          answer: 'Gemini is busy right now. Please try again in a moment.',
          sources: [],
          grounded: false,
          retrieved: 0,
          strategy: { vector: false, keyword: false, graph: false },
          degraded: { chroma: chromaStatus(), neo4j: neo4j.status() },
          tookMs: Date.now() - startedAt,
        });
      }
      const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'NOT_CONFIGURED' ? 503 : 502;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

/* ── GET /api/ask/health ─────────────────────────────────── */
router.get('/health', requireAuth, async (req, res) => {
  const total = await Document.estimatedDocumentCount().catch(() => null);
  res.json({
    indexedDocuments: total,
    chroma: chromaStatus(),
    neo4j: neo4j.status(),
  });
});

// Export the deterministic intent helper for fast offline regression tests.
router.isLatestDecisionQuestion = isLatestDecisionQuestion;

module.exports = router;
