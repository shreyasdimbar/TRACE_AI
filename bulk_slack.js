/**
 * Bulk-ingest Slack messages from a channel, from a given local time today.
 *
 * The /api/slack/fetch endpoint only takes the NEWEST N messages (no time
 * filter), so this pulls conversations.history with an `oldest` cutoff and
 * ingests concurrently. Dedup is left to ingestDocument via metadata.messageId,
 * so re-running is safe.
 *
 *   node bulk_slack.js social --since 11:00 --concurrency 4
 */
require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const { ingestDocument } = require('./services/ingestService');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const channelName = (args.find((a) => !a.startsWith('--')) || 'social').replace(/^#/, '');
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SINCE = flag('since', '11:00');
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 4)));
// Skip extractReasoning (a generate_content call). The free tier allows only
// 15 of those per minute per model, which throttles a bulk pull to ~15 min.
// Embeddings are a separate quota and unaffected, so vector search and source
// citations still work -- only the "AI Reasoning" panel is left empty.
const NO_REASONING = args.includes('--no-reasoning');

/** Today's <HH:MM> in the machine's local zone, as a Slack `oldest` ts. */
function sinceEpoch(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime() / 1000;
}

function ingestible(msg) {
  if (!msg || typeof msg.text !== 'string') return false;
  const text = msg.text.trim();
  if (!text || msg.subtype || msg.bot_id) return false;
  if (/^<@[A-Z0-9]+(\|[^>]*)?> (has joined|left the|set the channel)/i.test(text)) return false;
  return text.length > 2;
}

(async () => {
  const oldest = sinceEpoch(SINCE);
  console.log(`  since ${SINCE} local  ->  ts ${oldest}  (${new Date(oldest * 1000).toISOString()})`);

  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  const list = await client.conversations.list({ types: 'public_channel', exclude_archived: true, limit: 200 });
  const channel = (list.channels || []).find((c) => c.name === channelName);
  if (!channel) {
    console.error(`  #${channelName} not found or bot is not a member. Visible: ` +
      (list.channels || []).map((c) => '#' + c.name).join(' '));
    process.exit(1);
  }

  // Page backwards through history until we pass the cutoff.
  const messages = [];
  let cursor;
  do {
    const page = await client.conversations.history({
      channel: channel.id,
      oldest: String(oldest),
      inclusive: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    messages.push(...(page.messages || []));
    cursor = page.has_more ? page.response_metadata?.next_cursor : undefined;
  } while (cursor);

  const targets = messages.filter(ingestible);
  console.log(`  #${channelName}: ${messages.length} raw, ${targets.length} ingestible`);

  if (targets.length === 0) {
    console.log('  nothing to do.');
    await mongoose.disconnect();
    return;
  }

  const senders = new Map();
  for (const id of [...new Set(targets.map((m) => m.user).filter(Boolean))]) {
    try {
      const res = await client.users.info({ user: id });
      senders.set(id, res.user?.profile?.real_name || res.user?.name || id);
    } catch { senders.set(id, id); }
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  const started = Date.now();
  let done = 0;
  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  let cursorIdx = 0;

  async function worker() {
    while (cursorIdx < targets.length) {
      const msg = targets[cursorIdx++];
      const sender = senders.get(msg.user) || 'Unknown';
      try {
        let r;
        if (NO_REASONING) {
          const Document = require('./models/Document');
          const { getEmbedding } = require('./services/aiService');
          const { addToChroma } = require('./services/chromaService');
          const meta = {
            sender,
            channel: channel.name,
            channelId: channel.id,
            date: msg.ts ? new Date(Number(msg.ts) * 1000).toISOString() : undefined,
            messageId: msg.ts,
          };
          const dup = await Document.findOne({ 'metadata.messageId': msg.ts, source: 'slack' });
          if (dup) {
            r = { duplicate: true, skipped: 'already_ingested' };
          } else {
            const doc = await Document.create({
              source: 'slack',
              title: `Slack #${channel.name} - ${sender}`,
              rawContent: msg.text,
              summary: msg.text.slice(0, 240),
              decision: 'No decision',
              reasoning: '',
              tags: [],
              metadata: meta,
            });
            const docId = doc._id.toString();
            const embedding = await getEmbedding(msg.text, { task: 'document' });
            if (embedding.length > 0) {
              await addToChroma(docId, embedding, msg.text, {
                source: 'slack',
                title: doc.title,
                docId,
              });
            }
            try {
              const { storeDocumentNode } = require('./services/neo4jService');
              await storeDocumentNode(docId, doc.title, 'slack', 'No decision', []);
            } catch { /* graph is a derived index */ }
            r = { duplicate: false, docId };
          }
        } else {
          r = await ingestDocument({
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
        }
        if (r.duplicate) skipped += 1;
        else ingested += 1;
      } catch (err) {
        failed += 1;
        console.log(`    FAILED ts=${msg.ts}: ${err.message}`);
      }
      done += 1;
      if (done % 5 === 0 || done === targets.length) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ${done}/${targets.length}  ingested=${ingested} dup=${skipped} failed=${failed}  ${secs}s`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  console.log(`\n  DONE in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`    ingested : ${ingested}`);
  console.log(`    duplicate: ${skipped}`);
  console.log(`    failed   : ${failed}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error('  FAILED: ' + (e.message || e));
  process.exit(1);
});
