const express = require('express');
const router = express.Router();

const googleAuth = require('../services/googleAuth');
const { ingestDocument } = require('../services/ingestService');
const scheduler = require('../services/scheduler');
const { requireAuth } = require('./auth');
const Document = require('../models/Document');

const MAX_BODY_CHARS = Number(process.env.GMAIL_BODY_CHARS || 3000);
const MAX_RESULTS = Number(process.env.GMAIL_MAX_RESULTS || 50);

/* ──────────────────────────────────────────────────────────
   MIME helpers
   ────────────────────────────────────────────────────────── */

/**
 * Walk a MIME tree and collect candidate bodies.
 *
 * The old implementation only looked at top-level parts, so any multipart/mixed
 * message with an inline attachment — i.e. most real email — produced an empty
 * body and was silently dropped. This walks nested parts and keeps the best
 * available text.
 */
function collectBodies(payload, out = { plain: [], html: [] }) {
  if (!payload) return out;

  const mime = payload.mimeType || '';
  const data = payload.body?.data;

  if (data && !payload.parts) {
    const text = decodeBase64Url(data);
    if (mime === 'text/plain') out.plain.push(text);
    else if (mime === 'text/html') out.html.push(text);
    return out;
  }

  for (const part of payload.parts || []) {
    collectBodies(part, out);
  }
  return out;
}

function decodeBase64Url(data) {
  try {
    return Buffer.from(String(data), 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drop quoted history and signatures — they dominate threads and add no signal. */
function stripThreadNoise(text) {
  const lines = String(text).split('\n');
  const cut = lines.findIndex((l) => /^\s*(-{2,}\s*original message|on .{0,80} wrote:|_{5,}|from:\s)/i.test(l));
  const body = cut === -1 ? lines : lines.slice(0, cut);

  const sigIdx = body.findIndex((l) => /^\s*(--|__|best regards|regards,|sent from my)/i.test(l.trim()));
  const trimmed = sigIdx === -1 ? body : body.slice(0, sigIdx);

  return trimmed.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractBody(payload) {
  const { plain, html } = collectBodies(payload);
  let body = plain.filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  if (!body && html.length) body = htmlToText(html);
  return stripThreadNoise(body);
}

function headersToObject(headers = []) {
  const out = {};
  for (const h of headers) {
    const key = String(h.name || '').toLowerCase();
    if (key && out[key] === undefined) out[key] = h.value;
  }
  return out;
}

/* ──────────────────────────────────────────────────────────
   Sync
   ────────────────────────────────────────────────────────── */

/**
 * Ingest the most recent messages.
 * @param {{maxResults?: number, query?: string}} opts
 */
async function syncInbox({ maxResults = 10, query = 'newer_than:7d' } = {}) {
  const gmail = googleAuth.api('gmail');
  if (!gmail) return { error: 'Gmail is not connected. Visit /auth/google first.', code: 'NOT_CONNECTED' };

  const cap = Math.min(Math.max(Number(maxResults) || 10, 1), MAX_RESULTS);

  try {
    const listResp = await gmail.users.messages.list({
      userId: 'me',
      maxResults: cap,
      q: query,
      includeSpamTrash: false,
    });

    const refs = listResp.data.messages || [];
    const ingested = [];
    const skipped = [];

    for (const ref of refs) {
      const messageId = ref.id;

      // Scope the dedup key to this source: Slack ts values and Gmail ids are
      // different namespaces and must not collide in one query.
      const existing = await ingestHas(messageId);
      if (existing) {
        skipped.push({ messageId, reason: 'already_ingested' });
        continue;
      }

      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const headers = headersToObject(msg.data.payload?.headers);
      const body = extractBody(msg.data.payload);

      if (!body || body.length < 20) {
        skipped.push({ messageId, reason: 'no_text_body' });
        continue;
      }

      const result = await ingestDocument({
        source: 'gmail',
        title: headers.subject || 'No Subject',
        content: body.slice(0, MAX_BODY_CHARS),
        metadata: {
          sender: headers.from || 'Unknown',
          to: headers.to,
          date: headers.date || '',
          messageId,
          threadId: msg.data.threadId,
        },
        dedupQuery: { 'metadata.messageId': messageId, source: 'gmail' },
      });

      if (result.duplicate) skipped.push({ messageId, reason: result.skipped });
      else ingested.push({ docId: result.docId, subject: headers.subject, summary: result.summary });
    }

    return { success: true, fetched: refs.length, ingested_count: ingested.length, ingested, skipped_count: skipped.length, skipped };
  } catch (err) {
    // A rotated client secret invalidates the refresh token; drop it so the
    // scheduler goes idle instead of retrying forever, and so /api/gmail/status
    // stops claiming the account is linked.
    if (googleAuth.handleError(err)) {
      return { error: 'Google token was rejected. Re-run /auth/google to reconnect.', code: 'NOT_CONNECTED' };
    }
    const message = err?.errors?.[0]?.message || err.message;
    console.error(`[gmail] sync failed: ${message}`);
    return { error: message, code: 'GMAIL_ERROR' };
  }
}

// Cheap existence probe so we do not fetch + parse messages we already have.
function ingestHas(messageId) {
  return Document.exists({ 'metadata.messageId': messageId, source: 'gmail' });
}

/* ──────────────────────────────────────────────────────────
   Routes
   ────────────────────────────────────────────────────────── */

// ── GET /auth/google ─ start consent ───────────────────────
router.get('/auth/google', (req, res) => {
  try {
    res.redirect(googleAuth.getAuthUrl());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /auth/google/callback ──────────────────────────────
router.get('/auth/google/callback', async (req, res, next) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const oauthError = String(req.query.error || '');

    if (oauthError) {
      return res.status(400).json({ error: `Consent denied: ${oauthError}` });
    }
    if (!code) {
      return res.status(400).json({ error: 'Missing authorization code' });
    }

    // exchangeCode rejects a state this process never issued, or one already
    // spent, so an attacker cannot bind their own Google account to this server.
    await googleAuth.exchangeCode(code, state);
    res.json({
      success: true,
      message: 'Google connected. Gmail, Drive and Docs scopes granted.',
      scopes: googleAuth.status().scopes,
    });
  } catch (err) {
    if (err.code === 'INVALID_STATE') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ── GET /api/gmail/status ──────────────────────────────────
router.get('/api/gmail/status', requireAuth, (req, res) => {
  res.json(googleAuth.status());
});

// ── POST /api/gmail/fetch ──────────────────────────────────
router.post('/api/gmail/fetch', requireAuth, async (req, res) => {
  // Routed through the scheduler's shared gate so a click landing mid-cron-tick
  // joins that tick instead of starting a second pass over the same messages.
  // The params match the cron call exactly (maxResults 10, default
  // newer_than:7d query), so a coalesced result is the one a standalone run
  // would have returned anyway.
  const result = await scheduler.runExclusive('gmail', () =>
    syncInbox({
      // Accept both names: the client historically sent `count`.
      maxResults: req.body?.max_results ?? req.body?.count ?? 10,
      query: req.body?.query || undefined,
    })
  );

  if (result.error) {
    const status = result.code === 'NOT_CONNECTED' ? 401 : result.code === 'GMAIL_ERROR' ? 502 : 500;
    return res.status(status).json(result);
  }
  res.json(result);
});

module.exports = router;
module.exports.syncInbox = syncInbox;
module.exports.extractBody = extractBody;
