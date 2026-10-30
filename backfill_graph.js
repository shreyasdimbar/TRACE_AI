/**
 * backfill_graph.js — rebuild the Neo4j graph from documents already in MongoDB.
 *
 *   npm run backfill:graph
 *
 * Why this exists: the graph is a *derived* index. If it is wiped, emptied by
 * reset.js, or restored from an older backup, a normal sync will NOT bring it
 * back. ingestDocument() returns early for a document that already exists in
 * Mongo ("already_ingested"), and that early return happens before any graph
 * write — so re-running the Gmail or Slack fetch just skips everything.
 *
 * This replays the graph half of ingest for every stored document. It reads
 * Mongo only and makes no AI calls, so it costs nothing against the Gemini quota
 * and does not re-extract anything. It is idempotent: storeDocumentNode MERGEs.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const Document = require('./models/Document');
const { storeDocumentNode, countNodes, status, close } = require('./services/neo4jService');

const line = (c = '=') => console.log(c.repeat(74));

(async () => {
  line();
  console.log('  Trace.AI - graph backfill');
  line();

  if (!status().configured) {
    console.log('\n  Neo4j is not configured. Uncomment the NEO4J_* keys in .env first.');
    console.log('  (A backup of the previous .env exists at .env.pre-demo.bak)\n');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const docs = await Document.find({}, {
    title: 1, source: 1, decision: 1, tags: 1, metadata: 1,
    decisionHistory: 1, updatedAt: 1, createdAt: 1,
  }).sort({ createdAt: 1 }).lean();

  // Thread adjacency: for each thread, the item that precedes another one.
  // Computed here rather than stored, so a rebuild from Mongo alone is enough.
  const lastSeenInThread = new Map();
  const previousDocIdByDoc = new Map();
  for (const d of docs) {
    const tid = d.metadata?.threadId ? String(d.metadata.threadId) : '';
    if (!tid) continue;
    const prev = lastSeenInThread.get(tid);
    if (prev) previousDocIdByDoc.set(String(d._id), prev);
    lastSeenInThread.set(tid, String(d._id));
  }

  console.log(`\n  documents in MongoDB : ${docs.length}`);
  console.log(`  nodes in Neo4j before : ${await countNodes()}`);
  console.log('');

  if (!docs.length) {
    console.log('  nothing to backfill.\n');
    await mongoose.connection.close();
    await close();
    process.exit(0);
  }

  let written = 0;
  let failed = 0;

  for (const d of docs) {
    const tags = Array.isArray(d.tags) ? d.tags.filter(Boolean).slice(0, 12) : [];
    const ok = await storeDocumentNode(
      String(d._id),
      d.title || '(untitled)',
      d.source || 'unknown',
      d.decision || 'No decision',
      tags,
      {
        history: Array.isArray(d.decisionHistory) ? d.decisionHistory : [],
        previousDocId: previousDocIdByDoc.get(String(d._id)) || null,
      }
    );
    if (ok) written += 1;
    else failed += 1;
    const mark = ok ? '+' : '!';
    const title = String(d.title || '').slice(0, 52);
    const tagCount = tags.length;
    console.log(`  ${mark} ${title.padEnd(54)} tags=${String(tagCount).padStart(2)}`);
  }

  console.log(`\n  written : ${written}`);
  console.log(`  failed  : ${failed}`);
  console.log(`  nodes after : ${await countNodes()}`);

  line();
  console.log('');
  await mongoose.connection.close();
  await close();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n  FAILED:', err.message, '\n');
  process.exit(1);
});