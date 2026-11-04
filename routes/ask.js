const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Document = require('../models/Document');

const {
  getEmbedding,
  answerQuestion,
  answerGeneralQuestion,
  answerWritingQuestion,
  AiError,
} = require('../services/aiService');
const { queryChroma, status: chromaStatus } = require('../services/chromaService');
const neo4j = require('../services/neo4jService');
const { requireAuth } = require('./auth');
const {
  buildRetrievalQuery,
  buildRetrievalQueries,
  getPriorAssistantSearchHints,
  filterByEntityHints,
  isContextualFollowUp,
  asksForAllSources,
  getDateWindow,
  isWithinDateWindow,
  extractSearchTerms,
  rankDocuments,
  scoreLexicalDocument,
} = require('../services/retrieval');

const TOP_K = Number(process.env.ASK_TOP_K || 8);
const GRAPH_EXPANSION = Number(process.env.ASK_GRAPH_EXPANSION || 3);
const RETRIEVAL_CANDIDATES = Math.min(80, Math.max(TOP_K * 5, Number(process.env.ASK_CANDIDATE_K || 40)));
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
  const asksLatest = /\b(latest|newest|most\s+recent|current)\b/.test(text);
  const asksDecision = /\b(decision|decided|resolution|resolved)\b/.test(text);
  return asksLatest && asksDecision;
}

function getLatestDecisionTopic(input) {
  const ignored = new Set([
    'latest', 'newest', 'most', 'recent', 'current', 'decision', 'decisions', 'decided',
    'resolution', 'resolutions', 'resolve', 'resolved', 'made', 'make', 'choose',
    'chosen', 'outcome', 'project', 'team', 'company', 'organization', 'organizational',
    'our', 'their', 'theirs', 'latest', 'what', 'which', 'tell', 'me', 'show', 'find',
    'immediately', 'previous', 'prior', 'last', 'should', 'meeting', 'email', 'thread',
  ]);
  return extractSearchTerms(input).filter((term) => !ignored.has(term)).join(' ');
}

function isGlobalLatestDecisionQuestion(input) {
  return isLatestDecisionQuestion(input) && !getLatestDecisionTopic(input);
}

function isLatestEmailQuestion(input) {
  const text = String(input || '').toLowerCase();
  return /\b(?:latest|newest|most\s+recent|current)\b/.test(text) &&
    /\b(?:e-?mails?|mail)\b/.test(text);
}

function getLatestEmailTopic(input) {
  const match = String(input || '').match(/\b(?:regarding|about|concerning|on|for|from)\s+(.+?)\s*[?.!,;:]*$/i);
  if (!match) return '';
  return match[1].trim().replace(/^(?:the|a|an)\s+/i, '');
}

const WRITING_ACTION = /\b(write|draft|compose|create|rewrite|polish|proofread)\b/i;
const WRITING_MEDIUM = /\b(email|e-mail|mail|message|letter)\b/i;
const ARCHIVE_SIGNAL = /\b(our|organization|organizational|company|team|internal|indexed|archive|gmail|slack|google docs|transcript|source|decision|decided|resolution|action items?|meeting|policy|project|client|employee|manager|workflow|latest|previous|recent|last[ -]month|last[ -]week|last[ -]year|updates?|emails?|meeting notes?|what did .+ (?:say|decide|ask|agree))\b/i;
const ARCHIVE_WRITING_SIGNAL = /\b(company|organization|internal|indexed|archive|gmail|slack|google docs|transcript|source|latest|previous|decision|action items?|meeting notes?|what we (?:decided|agreed)|as (?:we )?agreed|our (?:team|company|organization|project|client|meeting notes?))\b/i;

function isWritingRequest(input) {
  const text = String(input || '');
  return WRITING_ACTION.test(text) && WRITING_MEDIUM.test(text);
}

/**
 * Route internal-knowledge questions to retrieval; everything else is normal
 * chatbot conversation. A plain email draft stays in writing mode unless the
 * user explicitly asks to base it on indexed/company context.
 *
 * This heuristic is only the FALLBACK when the client does not send an explicit
 * mode. The UI has a mode toggle (general chat vs. archive context), and the
 * user's explicit choice always wins.
 */
function isArchiveQuestion(input) {
  const text = String(input || '');
  if (isLatestDecisionQuestion(text)) return true;
  if (isWritingRequest(text) && !ARCHIVE_WRITING_SIGNAL.test(text)) return false;
  return ARCHIVE_SIGNAL.test(text);
}

const ASK_MODES = ['general', 'archive'];

/**
 * Resolve the answer mode for a single ask.
 *
 * `requestedMode` comes from the chat UI toggle. When it is absent or invalid
 * we fall back to the heuristic routing, so older clients / API callers keep
 * working without the toggle.
 */
function resolveAskMode(requestedMode, input) {
  const requested = String(requestedMode || '').toLowerCase().trim();
  if (ASK_MODES.includes(requested)) return requested;
  return isArchiveQuestion(input) ? 'archive' : 'general';
}

/** Keep follow-up context small and accept only chat text, never UI metadata. */
function cleanConversationHistory(input) {
  if (!Array.isArray(input)) return [];
  let remaining = 6000;
  const cleaned = [];
  const valid = input.map((message) => {
    const role = message?.role === 'assistant' || message?.role === 'ai'
      ? 'assistant'
      : message?.role === 'user' ? 'user' : null;
    const content = String(message?.content || '').trim();
    return role && content ? { role, content } : null;
  }).filter(Boolean);

  for (const message of valid.slice(-8)) {
    if (remaining <= 0) break;
    const { role, content } = message;
    const safeContent = content.slice(0, Math.min(1500, remaining));
    cleaned.push({ role, content: safeContent });
    remaining -= safeContent.length;
  }
  return cleaned;
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
  "Hi! I'm Trace.AI — I can chat, help draft emails, or search your organization's indexed sources. What can I help with?";

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

const LEXICAL_FIELDS = [
  'title', 'source', 'summary', 'rawContent', 'decision', 'decisionHistory.text',
  'decisionHistory.summary', 'decisionHistory.fromTitle', 'reasoning', 'tags',
  'metadata.sender', 'metadata.to', 'metadata.channel', 'metadata.participants',
  'metadata.channelId', 'metadata.messageId', 'metadata.date', 'metadata.threadId',
  'metadata.googleDocId', 'metadata.link',
];

const STRUCTURED_FALLBACK_FIELDS = LEXICAL_FIELDS.filter((field) => field !== 'rawContent');
const EMAIL_TOPIC_FIELDS = [
  'title', 'rawContent', 'summary', 'decision', 'reasoning',
  'metadata.sender', 'metadata.to', 'metadata.participants',
];

function sourceTimestamp(doc) {
  const sourceDate = Date.parse(doc?.metadata?.date || '');
  if (Number.isFinite(sourceDate)) return sourceDate;
  const fallbackDate = Date.parse(doc?.createdAt || doc?.updatedAt || '');
  return Number.isFinite(fallbackDate) ? fallbackDate : 0;
}

/**
 * "Latest email about X" is a source-and-entity lookup, not a semantic query.
 * Require every entity term in the same Gmail record, then choose by message
 * date. This avoids recent unrelated mail winning on generic words like
 * "service" or "update".
 */
async function retrieveLatestEmail(question, history = []) {
  const topic = getLatestEmailTopic(question);
  const topicTerms = extractSearchTerms(topic, 10);
  const filter = { source: 'gmail' };

  if (topic) {
    if (!topicTerms.length) return [];
    filter.$and = topicTerms.map((term) => ({
      $or: EMAIL_TOPIC_FIELDS.map((field) => ({
        [field]: { $regex: `\\b${escapeRegex(term)}\\b`, $options: 'i' },
      })),
    }));
  }

  const matches = await Document.find(filter).lean();
  const dateWindow = getDateWindow(question, new Date(), history);
  const datedMatches = dateWindow ? matches.filter((doc) => isWithinDateWindow(doc, dateWindow)) : matches;
  datedMatches.sort((a, b) => sourceTimestamp(b) - sourceTimestamp(a));
  return datedMatches.slice(0, 1);
}

function noEvidenceMessage(question) {
  if (getDateWindow(question)) {
    return 'I could not find matching indexed updates in that time range. Try widening the date range or syncing the relevant source.';
  }
  if (!isLatestEmailQuestion(question)) {
    return 'I could not find anything relevant to that in the indexed sources. Try different keywords, or ingest more data.';
  }
  const topic = getLatestEmailTopic(question);
  return topic
    ? "I couldn't find a matching indexed Gmail email for that topic. Check that Gmail has synced, or try a sender or subject keyword."
    : "I couldn't find an indexed Gmail email. Check that Gmail has synced, then try again.";
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Weighted full-text search plus an independent exact structured-field pass. */
async function keywordSearch(question, limit) {
  const terms = extractSearchTerms(question, 12);
  if (!terms.length) return [];

  let textDocs = [];
  let textSearchFailed = false;
  try {
    textDocs = await Document.aggregate([
      { $match: { $text: { $search: question } } },
      { $addFields: { score: { $meta: 'textScore' } } },
      { $sort: { score: -1, createdAt: -1 } },
      { $limit: limit },
    ]);
  } catch (err) {
    textSearchFailed = true;
    // A missing text index must not turn into a recency search: recent but
    // unrelated documents create false context and encourage bad answers.
    console.warn(`[ask] text search unavailable (${err.message}); using exact-term fallback`);
  }

  const pattern = terms.map(escapeRegex).join('|');
  // Run this even when Mongo text search fills its page: text rank can be
  // saturated by broad body matches while an exact title/name/decision match
  // lives below the cutoff. The bound keeps this fallback predictable as the
  // archive grows; the weighted text index handles general full-text recall.
  const fallbackFields = textSearchFailed ? LEXICAL_FIELDS : STRUCTURED_FALLBACK_FIELDS;
  const fallbackLimit = Math.min(1000, Math.max(limit * 10, 120));
  const fallbackDocs = await Document.find({
    $or: fallbackFields.map((field) => ({ [field]: { $regex: `\\b(?:${pattern})\\b`, $options: 'i' } })),
  })
    .select(`_id source title summary decision decisionHistory reasoning tags metadata createdAt updatedAt${textSearchFailed ? ' rawContent' : ''}`)
    .limit(fallbackLimit)
    .lean();

  const rankedFallback = fallbackDocs
    .map((doc) => ({ doc, score: scoreLexicalDocument(question, doc, { includeBody: textSearchFailed }) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.doc.updatedAt || b.doc.createdAt) - new Date(a.doc.updatedAt || a.doc.createdAt))
    .map((entry) => entry.doc);

  return rankDocuments(textDocs, rankedFallback, limit);
}

/**
 * Retrieve candidates, then decide whether we actually have a grounded answer.
 *
 * The previous version's final fallback fed four arbitrary recent documents to
 * the model whenever both semantic and keyword search missed, which produced
 * confident answers built from unrelated content. We now return an explicit
 * "no evidence" response instead of guessing.
 */
async function retrieve(question, history = []) {
  const strategy = { vector: false, keyword: false, graph: false };

  if (isLatestEmailQuestion(question)) {
    const latestEmail = await retrieveLatestEmail(question, history);
    return {
      docs: latestEmail,
      strategy: { ...strategy, keyword: latestEmail.length > 0 },
    };
  }

  // A global "latest decision" request has a deterministic answer: the newest
  // updated document with an actual decision. Do not let vector similarity pick
  // a different, older item, or return the no-evidence response just because
  // the question omitted a document title. The selected document's decision
  // history is passed through to buildContext() and the citation payload.
  if (isGlobalLatestDecisionQuestion(question)) {
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

  const retrievalQueries = buildRetrievalQueries(question, history);
  const dateWindow = getDateWindow(question, new Date(), history);
  let docs = [];

  const queryResults = await Promise.all(retrievalQueries.map(async (retrievalQuery) => {
    const [embedding, keywordDocs] = await Promise.all([
      getEmbedding(retrievalQuery, { task: 'query' }),
      keywordSearch(retrievalQuery, RETRIEVAL_CANDIDATES),
    ]);

    let vectorDocs = [];
    if (embedding.length) {
      const hits = await queryChroma(embedding, RETRIEVAL_CANDIDATES);
      const ids = hits.map((h) => h.docId).filter(isObjectId);
      if (ids.length) {
        const found = await Document.find({ _id: { $in: ids } }).lean();
        const byId = new Map(found.map((doc) => [String(doc._id), doc]));
        vectorDocs = hits.map((hit) => byId.get(String(hit.docId))).filter(Boolean);
      }
    }

    return { vectorDocs, keywordDocs };
  }));

  const mergeQueryRankings = (key) => {
    const lists = queryResults.map((result) => result[key]);
    if (lists.length < 2) return lists[0] || [];
    return rankDocuments(lists[0], lists[1], RETRIEVAL_CANDIDATES);
  };
  const vectorDocs = mergeQueryRankings('vectorDocs');
  let keywordDocs = mergeQueryRankings('keywordDocs');
  // Only a referential follow-up ("updates on both") inherits entities from the
  // previous answer. A self-contained question must keep its own scope.
  const assistantHints = isContextualFollowUp(question)
    ? getPriorAssistantSearchHints(history)
    : [];
  if (assistantHints.length) {
    const hintResults = await Promise.all(
      assistantHints.map((hint) => keywordSearch(hint, RETRIEVAL_CANDIDATES))
    );
    const rankedHints = hintResults.reduce(
      (combined, results) => rankDocuments(combined, results, RETRIEVAL_CANDIDATES),
      []
    );
    // Entity hints parsed from the prior answer are the highest-precision
    // signal for a follow-up such as "updates on both"; weight them above the
    // literal follow-up wording so generic words cannot crowd them out.
    keywordDocs = rankDocuments(keywordDocs, rankedHints, RETRIEVAL_CANDIDATES, {
      keywordWeight: 1.8,
    });
  }
  strategy.vector = vectorDocs.length > 0;

  strategy.keyword = keywordDocs.length > 0;
  let rankedDocs = rankDocuments(vectorDocs, keywordDocs, RETRIEVAL_CANDIDATES);

  // A follow-up such as "updates on both" must stay scoped to the entities the
  // previous answer named. Without this, generic words like "update" pull in
  // unrelated mail and crowd out the projects actually being asked about.
  // "everything means every email every doc and every tile" opts out of that
  // scoping and asks for a full sweep of the archive.
  if (assistantHints.length && !asksForAllSources(question)) {
    rankedDocs = filterByEntityHints(rankedDocs, assistantHints);
  }

  const timeQualifiedDocs = dateWindow
    ? rankedDocs.filter((doc) => isWithinDateWindow(doc, dateWindow))
    : rankedDocs;
  docs = timeQualifiedDocs.slice(0, TOP_K);

  // A scoped latest-decision question is about recency among matching decisions,
  // not whichever document happens to be the nearest semantic neighbour.
  if (isLatestDecisionQuestion(question)) {
    const topic = getLatestDecisionTopic(question);
    if (topic) {
      const matchingDecisions = rankedDocs
        .filter((doc) => doc.decision && doc.decision !== NO_DECISION && scoreLexicalDocument(topic, doc) > 0)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      if (matchingDecisions.length) docs = [matchingDecisions[0]];
    }
  }

  // Widen via the knowledge graph: documents that share tags with the best
  // hits, or that arrived with the same decision.
  if (docs.length && GRAPH_EXPANSION > 0 && !isLatestDecisionQuestion(question) && !dateWindow) {
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
  // Keep the resolved mode in the handler scope so timeout/error responses can
  // report it from the catch block as well as normal responses from the try.
  const mode = resolveAskMode(req.body?.mode, question);

  try {
    const writingRequest = isWritingRequest(question);
    const history = cleanConversationHistory(req.body?.history);

    // Friendly greetings stay instant. They are conversational, not an archive
    // answer, so don't label them as failed grounding in the UI.
    if (isSmalltalk(question)) {
      return res.json({
        answer: SMALLTALK_REPLY,
        sources: [],
        grounded: null,
        mode: 'chat',
        retrieved: 0,
        strategy: { vector: false, keyword: false, graph: false },
        degraded: { chroma: chromaStatus() },
        tookMs: Date.now() - startedAt,
      });
    }

    // An explicit "general" choice from the chat toggle: plain conversation and
    // standalone drafting, no archive retrieval, no grounding requirement. An
    // explicit "archive" choice goes through retrieval below, whatever the words
    // say.
    if (mode === 'general') {
      const result = writingRequest
        ? await answerWritingQuestion(question, [], history)
        : { answer: await answerGeneralQuestion(question, history), sources: [] };
      return res.json({
        answer: result.answer,
        sources: result.sources || [],
        grounded: result.sources?.length ? true : null,
        mode: writingRequest ? 'writing' : 'chat',
        retrieved: 0,
        strategy: { vector: false, keyword: false, graph: false },
        degraded: { chroma: chromaStatus() },
        tookMs: Date.now() - startedAt,
      });
    }

    const total = await Document.estimatedDocumentCount();
    if (total === 0) {
      if (writingRequest) {
        const result = await answerWritingQuestion(question, [], history);
        return res.json({
          answer: result.answer,
          sources: [],
          grounded: null,
          mode: 'writing',
          retrieved: 0,
          strategy: { vector: false, keyword: false, graph: false },
          degraded: { chroma: chromaStatus() },
          tookMs: Date.now() - startedAt,
        });
      }
      return res.json({
        answer: 'There is nothing indexed yet. Ingest some data first, then ask again.',
        sources: [],
        grounded: false,
        retrieved: 0,
        strategy: { vector: false, keyword: false, graph: false },
        degraded: { chroma: chromaStatus() },
      });
    }

    const { docs, strategy } = await retrieve(question, history);

    // No evidence at all: say so instead of inventing an answer.
    if (!docs.length) {
      if (writingRequest) {
        const result = await answerWritingQuestion(question, [], history);
        return res.json({
          answer: result.answer,
          sources: [],
          grounded: null,
          mode: 'writing',
          retrieved: 0,
          strategy,
          degraded: { chroma: chromaStatus() },
          tookMs: Date.now() - startedAt,
        });
      }
      return res.json({
        answer: noEvidenceMessage(question),
        sources: [],
        grounded: false,
        retrieved: 0,
        strategy,
        degraded: { chroma: chromaStatus() },
        tookMs: Date.now() - startedAt,
      });
    }

    const { answer, sources } = writingRequest
      ? await answerWritingQuestion(question, docs, history)
      : await answerQuestion(question, docs, history);

    // If the model says it could not find it, do not present citations as
    // proof. An abstention with a wall of sources underneath reads as "here is
    // your answer and also nine documents you did not ask for" — so the source
    // list goes empty to match the answer.
    const abstained = !writingRequest && /could not find|not (?:present|in) the (?:indexed|context|provided)/i.test(answer);
    const payload = abstained ? [] : sources;

    res.json({
      answer,
      sources: payload,
      grounded: writingRequest ? (payload.length > 0 ? true : null) : !abstained,
      mode: writingRequest ? 'writing' : 'archive',
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
          mode,
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

// Export the deterministic intent helpers for fast offline regression tests.
router.isLatestDecisionQuestion = isLatestDecisionQuestion;
router.isWritingRequest = isWritingRequest;
router.isArchiveQuestion = isArchiveQuestion;
router.resolveAskMode = resolveAskMode;
router.cleanConversationHistory = cleanConversationHistory;
router.getLatestDecisionTopic = getLatestDecisionTopic;
router.isGlobalLatestDecisionQuestion = isGlobalLatestDecisionQuestion;
router.isLatestEmailQuestion = isLatestEmailQuestion;
router.getLatestEmailTopic = getLatestEmailTopic;
router.noEvidenceMessage = noEvidenceMessage;
router.retrieve = retrieve;
router.keywordSearch = keywordSearch;
router.buildRetrievalQuery = buildRetrievalQuery;
router.rankDocuments = rankDocuments;
router.scoreLexicalDocument = scoreLexicalDocument;

module.exports = router;
