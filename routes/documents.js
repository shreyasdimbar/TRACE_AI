const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Document = require('../models/Document');
const { removeDocument } = require('../services/ingestService');
const { requireAuth } = require('./auth');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

const SOURCES = ['gmail', 'slack', 'google_docs', 'manual', 'transcript'];

/**
 * rawContent is included by default because the documents UI renders it in the
 * expanded view. Callers that only need metadata (dashboards, counts) can pass
 * ?includeContent=false to avoid shipping several KB per document.
 */
const LEAN_FIELDS = '-rawContent';

function parseLimit(raw, fallback = DEFAULT_LIMIT) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

function parseSkip(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/* ── GET /api/documents ──────────────────────────────────── */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { source, limit, skip, search, includeContent } = req.query;

    if (source && !SOURCES.includes(String(source))) {
      return res.status(400).json({ error: `source must be one of: ${SOURCES.join(', ')}` });
    }

    const limitN = parseLimit(limit);
    const skipN = parseSkip(skip);
    const fields = String(includeContent).toLowerCase() === 'false' ? LEAN_FIELDS : null;

    const filter = {};
    if (source) filter.source = String(source);
    if (search && String(search).trim()) {
      // Escape the input: an unescaped regex here is a ReDoS vector.
      const safe = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.title = { $regex: safe, $options: 'i' };
    }

    let query = Document.find(filter).sort({ createdAt: -1 }).skip(skipN).limit(limitN);
    if (fields) query = query.select(fields);

    const [documents, total] = await Promise.all([
      query.lean(),
      Document.countDocuments(filter),
    ]);

    res.json({
      documents,
      total,
      limit: limitN,
      skip: skipN,
      hasMore: skipN + documents.length < total,
    });
  } catch (err) {
    next(err);
  }
});

/* ── GET /api/documents/stats ────────────────────────────── */
router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const rows = await Document.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 }, latest: { $max: '$createdAt' } } },
      { $sort: { count: -1 } },
    ]);

    const bySource = {};
    let total = 0;
    for (const r of rows) {
      bySource[r._id] = { count: r.count, latest: r.latest };
      total += r.count;
    }
    res.json({ total, bySource });
  } catch (err) {
    next(err);
  }
});

/* ── GET /api/documents/:id ──────────────────────────────── */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    // An invalid id makes findById throw a CastError; return 400 not 500.
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Malformed document id' });
    }

    const doc = await Document.findById(id).lean();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    res.json(doc);
  } catch (err) {
    next(err);
  }
});

/* ── DELETE /api/documents/:id ───────────────────────────── */
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Malformed document id' });
    }

    const removed = await removeDocument(id);
    if (!removed) return res.status(404).json({ error: 'Document not found' });

    res.json({ success: true, docId: id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
