const express = require('express');
const router = express.Router();
const { ingestDocument, IngestError } = require('../services/ingestService');
const { normaliseTranscript } = require('../services/transcriptParser');
const { requireAuth } = require('./auth');

/** Sources a caller may claim for a manual ingest. */
const MANUAL_SOURCES = new Set(['manual', 'transcript', 'note', 'document']);

/* ── POST /api/ingest ────────────────────────────────────── */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { source, title, content } = req.body || {};
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};

    const cleanSource = String(source || 'manual').trim();
    if (!MANUAL_SOURCES.has(cleanSource)) {
      return res.status(400).json({
        error: `source must be one of: ${[...MANUAL_SOURCES].join(', ')}`,
      });
    }

    let cleanContent = content;
    // Transcripts arrive as plain text OR as a JSON export from Zoom/Meet/
    // Teams. Storing the JSON verbatim made the vector mostly punctuation and
    // field names and hid every speaker, so it is flattened to readable lines
    // before it ever reaches the model. Anything unrecognised is passed through
    // untouched -- content is never dropped.
    let transcriptReport = null;
    let transcriptMeta = null;
    if (cleanSource === 'transcript') {
      const t = normaliseTranscript(content);
      cleanContent = t.text;
      // The response reports the normaliser's vocabulary; the stored copy uses
      // the field the Document schema actually declares (`participants`) --
      // the metadata subdocument is closed and drops anything undeclared.
      transcriptReport = { format: t.format, segments: t.segments, speakers: t.speakers };
      transcriptMeta = {
        transcriptFormat: t.format,
        transcriptSegments: t.segments,
        ...(t.speakers.length ? { participants: t.speakers } : {}),
      };
    }

    const result = await ingestDocument({
      source: cleanSource,
      title,
      content: cleanContent,
      metadata: { ...metadata, ...transcriptMeta },
    });

    res.status(result.created ? 201 : 200).json({ success: true, transcript: transcriptReport, ...result });
  } catch (err) {
    if (err instanceof IngestError) {
      const status =
        err.code === 'EMPTY_CONTENT' || err.code.startsWith('MISSING_') || err.code === 'TITLE_TOO_LONG'
          ? 400
          : 500;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

module.exports = router;
