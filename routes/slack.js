const express = require('express');
const router = express.Router();
const { WebClient } = require('@slack/web-api');

const { ingestDocument } = require('../services/ingestService');
const scheduler = require('../services/scheduler');
const { requireAuth } = require('./auth');

const HISTORY_PAGE = Number(process.env.SLACK_PAGE_SIZE || 20);
const SLACK_CONCURRENCY = Math.max(1, Number(process.env.SLACK_CONCURRENCY || 4));

let slack = null;

function isConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

function getClient() {
  if (!isConfigured()) return null;
  if (!slack) slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  return slack;
}

/**
 * List public channels once per tick.
 *
 * The old cron called conversations.list() inside the per-channel sync, so a
 * workspace with N channels produced N+1 list calls every minute.
 */
async function listChannels(client = getClient()) {
  if (!client) return [];
  const response = await client.conversations.list({
    types: 'public_channel',
    exclude_archived: true,
    limit: 200,
  });
  return (response.channels || []).map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Read a channel's history, joining first only if the read is refused.
 * `conversations.join` used to be called unconditionally on every fetch, which
 * burned a write-API call per channel per minute.
 */
async function readHistory(client, channel) {
  const read = () =>
    client.conversations.history({
      channel: channel.id,
      limit: HISTORY_PAGE,
      inclusive: true,
    });

  try {
    return await read();
  } catch (err) {
    if (err?.data?.error === 'not_in_channel') {
      await client.conversations.join({ channel: channel.id });
      return read();
    }
    throw err;
  }
}

function isIngestible(msg) {
  if (!msg || typeof msg.text !== 'string') return false;
  const text = msg.text.trim();
  if (!text) return false;
  // Skip edits, deletions, joins, and other system subtypes.
  if (msg.subtype) return false;
  if (msg.bot_id) return false;
  // Slack control payloads render as "<@U123> has joined the channel".
  if (/^<@[A-Z0-9]+(\|[^>]*)?> (has joined|left the|set the channel)/i.test(text)) return false;
  return text.length > 2;
}

/**
 * Run tasks with bounded concurrency.
 *
 * Slack rate-limits per-method, and firing `users.info` for every sender at once
 * gets a busy channel throttled. Errors are returned per item so one failure
 * never sinks the batch.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Resolve display names for a batch of user ids.
 *
 * Each unique sender is looked up once and the result reused, at most
 * SLACK_CONCURRENCY at a time, falling back to the raw id on failure.
 */
async function resolveSenders(client, userIds) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const names = new Map();

  await mapLimit(unique, SLACK_CONCURRENCY, async (id) => {
    try {
      const res = await client.users.info({ user: id });
      names.set(id, res.user?.profile?.real_name || res.user?.name || id);
    } catch {
      names.set(id, id);
    }
  });

  return names;
}

/**
 * Ingest recent messages from one channel.
 * @param {{id: string, name: string}} channel  a channel object, not a name
 */
async function syncChannel(channel, { limit = HISTORY_PAGE, client = getClient() } = {}) {
  if (!client) return { error: 'SLACK_BOT_TOKEN is not set', code: 'NOT_CONFIGURED' };

  try {
    const history = await readHistory(client, channel);
    // conversations.history returns NEWEST first, so take from the front. The
    // previous code sliced from the end, which handed back the oldest messages
    // in the page: the poller kept re-ingesting the same stale window and never
    // picked up anything new.
    const messages = (history.messages || []).filter(isIngestible).slice(0, limit);
    const senders = await resolveSenders(client, messages.map((m) => m.user));

    const ingested = [];
    const skipped = [];

    for (const msg of messages) {
      const sender = senders.get(msg.user) || 'Unknown';

      // Slack ts values are unique per message, so this is a stable dedup key.
      const result = await ingestDocument({
        source: 'slack',
        title: `Slack #${channel.name} - ${sender}`,
        content: msg.text,
        metadata: {
          sender,
          channel: channel.name,
          channelId: channel.id,
          date: msg.ts ? new Date(Number(msg.ts) * 1000).toISOString() : undefined,
          messageId: msg.ts,
        },
        dedupQuery: { 'metadata.messageId': msg.ts, source: 'slack' },
      });

      if (result.duplicate) skipped.push({ messageId: msg.ts, reason: result.skipped });
      else ingested.push({ docId: result.docId, summary: result.summary, decision: result.decision });
    }

    return { success: true, channel: channel.name, ingested_count: ingested.length, ingested, skipped_count: skipped.length };
  } catch (err) {
    return { error: err?.data?.error || err.message, code: 'SLACK_ERROR' };
  }
}

/** Sync every public channel. Shared by the manual endpoint and the cron. */
async function syncAllChannels({ limit = 5 } = {}) {
  const client = getClient();
  if (!client) return { error: 'SLACK_BOT_TOKEN is not set', code: 'NOT_CONFIGURED' };

  const channels = await listChannels(client);
  let ingested = 0;
  const errors = [];

  for (const channel of channels) {
    const result = await syncChannel(channel, { limit, client });
    if (result.error) errors.push({ channel: channel.name, error: result.error });
    else ingested += result.ingested_count;
  }

  return { success: true, channels: channels.length, ingested_count: ingested, errors };
}

/* ── GET /api/slack/channels ─────────────────────────────── */
router.get('/channels', requireAuth, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'SLACK_BOT_TOKEN is not configured' });
    }
    const channels = await listChannels();
    res.json({ channels });
  } catch (err) {
    next(err);
  }
});

/* ── POST /api/slack/fetch ───────────────────────────────── */
router.post('/fetch', requireAuth, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'SLACK_BOT_TOKEN is not configured' });
    }

    const channelName = String(req.body?.channel_name || 'general').trim().replace(/^#/, '');
    const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 50);

    // Look the channel up once, then hand the object to the sync.
    const channels = await listChannels();
    const channel = channels.find((c) => c.name === channelName);
    if (!channel) {
      return res.status(404).json({ error: `Channel #${channelName} not found`, available: channels.map((c) => c.name) });
    }

    // Shares the 'slack' gate with the cron all-channels pass so the two never
    // read the same messages concurrently. The operations differ — one channel
    // here, every channel there — but both resolve to a numeric ingested_count,
    // which is all the client reads off this response.
    const result = await scheduler.runExclusive('slack', () => syncChannel(channel, { limit }));
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── GET /api/slack/health ───────────────────────────────── */
router.get('/health', requireAuth, (req, res) => {
  res.json({ configured: isConfigured() });
});

module.exports = router;
module.exports.syncAllChannels = syncAllChannels;
module.exports.isConfigured = isConfigured;
module.exports.listChannels = listChannels;
