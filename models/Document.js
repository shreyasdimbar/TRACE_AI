const mongoose = require('mongoose');

const NO_DECISION = 'No decision';

/**
 * Document — one ingested artefact from any source.
 *
 * Two fields carry more weight than they look:
 *  - `degraded` records that AI extraction failed but the document was kept
 *    anyway (aiService fails soft). Without it a degraded document is
 *    indistinguishable from a cleanly extracted one.
 *  - `timestamps` gives both createdAt and updatedAt. The Google Docs ingester
 *    updates in place, so updatedAt is the only signal that a document changed.
 */
const DocumentSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: [true, 'source is required'],
      trim: true,
    },
    title: { type: String, required: [true, 'title is required'], trim: true },
    rawContent: { type: String, required: [true, 'rawContent is required'] },
    summary: { type: String, default: '' },
    decision: { type: String, default: NO_DECISION },
    reasoning: { type: String, default: '' },
    tags: { type: [String], default: [] },

    /**
     * Superseded decisions for this artefact, oldest FIRST; the current
     * decision always lives in `decision`, never in this list.
     *
     * Without it, an in-place re-sync (Google Docs edited and re-fetched) or a
     * follow-up mail in the same thread simply overwrote `decision`, so the
     * archive could answer "what was decided" but never "what changed". Each
     * entry records what was believed before, when it stopped being current,
     * and - for threaded sources - which earlier item it came from.
     *
     * Capped in services/ingestService.js. Mongo is the source of truth for
     * this history; Neo4j mirrors it as a linked chain for graph traversal.
     */
    decisionHistory: {
      type: [
        {
          _id: false,
          text: { type: String, required: true },
          summary: { type: String, default: '' },
          // ISO string, not Date: this is display data and travels to the
          // graph as-is without timezone ambiguity.
          decidedAt: { type: String, default: '' },
          // Set when the superseded decision came from a different item in the
          // same thread (an earlier mail/message) rather than from this one.
          fromDocId: { type: String, default: null },
          fromTitle: { type: String, default: null },
        },
      ],
      default: [],
    },

    // AiError code from extraction, e.g. NOT_CONFIGURED / UPSTREAM_UNAVAILABLE.
    degraded: { type: String, default: null },

    /**
     * Provider-specific identifiers.
     *
     * This is a closed subdocument: Mongoose silently drops any key that is not
     * declared here. Every field the ingest paths write must be listed below or
     * it will vanish on save. Keep in sync with the `metadata` objects built in
     * routes/gmail.js, routes/slack.js and routes/gdocs.js.
     */
    metadata: {
      // Slack + Gmail
      sender: String,
      to: String,
      channel: String,
      channelId: String,
      messageId: String,
      threadId: String,
      date: String,
      participants: [String],

      // Google Drive
      link: String,
      googleDocId: String,
      createdTime: String,
      modifiedTime: String,
      fullLength: Number,

      // Meeting transcripts (services/transcriptParser.js). `speakers` is
      // written into `participants` above, which already existed.
      transcriptFormat: String,
      transcriptSegments: Number,
    },
  },
  { timestamps: true, minimize: false }
);

// ── Indexes ────────────────────────────────────────────────────

// Keyword fallback for /api/ask when the vector store is unreachable.
DocumentSchema.index(
  {
    title: 'text',
    source: 'text',
    decision: 'text',
    'decisionHistory.text': 'text',
    'decisionHistory.summary': 'text',
    'decisionHistory.fromTitle': 'text',
    summary: 'text',
    tags: 'text',
    reasoning: 'text',
    'metadata.sender': 'text',
    'metadata.to': 'text',
    'metadata.channelId': 'text',
    'metadata.messageId': 'text',
    'metadata.threadId': 'text',
    'metadata.googleDocId': 'text',
    'metadata.channel': 'text',
    'metadata.participants': 'text',
    'metadata.date': 'text',
    rawContent: 'text',
  },
  {
    name: 'document_search_text_v2',
    weights: {
      title: 12,
      source: 2,
      decision: 10,
      'decisionHistory.text': 8,
      'decisionHistory.fromTitle': 5,
      'decisionHistory.summary': 3,
      summary: 8,
      tags: 6,
      reasoning: 5,
      'metadata.sender': 4,
      'metadata.to': 3,
      'metadata.channelId': 2,
      'metadata.messageId': 1,
      'metadata.threadId': 2,
      'metadata.googleDocId': 2,
      'metadata.channel': 3,
      'metadata.participants': 2,
      'metadata.date': 2,
      rawContent: 1,
    },
  }
);

// The documents list is always filtered by source and sorted newest-first.
// This compound index serves both the filter and the sort, so it also covers
// source-only queries via its prefix — no separate single-field index needed.
DocumentSchema.index({ source: 1, createdAt: -1 });

/**
 * Dedup is enforced by the index, not by findOne-then-insert. The scheduler
 * ticks on a timer while the manual fetch endpoint is also callable by hand, so
 * a check followed by an insert can interleave and duplicate documents. A
 * unique index turns that race into an E11000 the ingest path can handle.
 *
 * Partial + $type guards keep manual/transcript documents (which have no
 * provider id) out of the index, and keep docs from different sources with a
 * coincidentally equal id from colliding.
 */
DocumentSchema.index(
  { 'metadata.messageId': 1, source: 1 },
  {
    unique: true,
    partialFilterExpression: { 'metadata.messageId': { $type: 'string' } },
    name: 'uniq_provider_message',
  }
);

DocumentSchema.index(
  { 'metadata.googleDocId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'metadata.googleDocId': { $type: 'string' } },
    name: 'uniq_google_doc',
  }
);

module.exports = mongoose.model('Document', DocumentSchema);
