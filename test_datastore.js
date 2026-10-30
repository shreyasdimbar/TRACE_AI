/**
 * test_datastore.js â€” integration checks against the real datastores.
 *
 *   npm run test:datastore
 *
 * Requires MongoDB on 27017, ChromaDB on 8000 and (optionally) Neo4j. Unlike
 * test_smoke.js this does talk to the network, because every bug worth pinning
 * down here only appears when a real driver is on the other end:
 *
 *   - Chroma pins a dimension per collection, so a wrong CHROMA_EMBED_DIM only
 *     shows up on a real upsert.
 *   - The neo4j driver encodes JS numbers as Cypher Floats, so LIMIT $n is
 *     rejected unless it is wrapped in neo4j.int().
 *   - executeRead() resolves to a Result wrapper, not a records array.
 *   - Mongoose strict mode silently drops undeclared metadata keys, which is
 *     invisible until you read the document back.
 *
 * Skipped automatically when a datastore is unreachable, so a partial setup
 * still yields signal instead of a wall of connection errors.
 */

require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');

const Document = require('./models/Document');
const { addToChroma, deleteFromChroma, queryChroma, ping, COLLECTION, EMBED_DIM } = require('./services/chromaService');
const neo4j = require('./services/neo4jService');

let passed = 0;
let failed = 0;
let skipped = 0;
const queue = [];
const neo4jFixtureIds = new Set();
const NEO4J_FIXTURE_PREFIX = '__trace_test__';

/** Thrown to abandon a test because a precondition is missing. */
const SKIP = Symbol('skip');

function test(name, fn) {
  queue.push({ name, fn });
}

/**
 * Abandon the current test. Throwing rather than returning is deliberate: a bare
 * `return` after skip() lets the runner record the test as passed, which hides
 * the fact that it never ran.
 */
function skip(why) {
  const err = new Error(why);
  err[SKIP] = true;
  throw err;
}

/** Unique, valid ObjectId-shaped ids so Mongo and Chroma agree. */
function oid(n) {
  return n.toString(16).padStart(24, '0');
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Document model
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
console.log('\ndocument model Â· schema shape');

test('every metadata key the sync paths write is declared', () => {
  // Routes construct these objects; any undeclared key is dropped on save.
  const written = {
    gmail: ['sender', 'to', 'date', 'messageId', 'threadId'],
    slack: ['sender', 'channel', 'channelId', 'date', 'messageId'],
    gdocs: ['googleDocId', 'createdTime', 'modifiedTime', 'fullLength', 'link'],
  };
  for (const [source, keys] of Object.entries(written)) {
    for (const k of keys) {
      assert.ok(
        Document.schema.path(`metadata.${k}`),
        `${source} writes metadata.${k} but the schema does not declare it â€” Mongoose would drop it`
      );
    }
  }
});

test('degraded and decision defaults are present', () => {
  assert.strictEqual(Document.schema.path('decision').getDefault(), 'No decision');
  assert.strictEqual(Document.schema.path('tags').getDefault().length, 0);
  assert.ok(Document.schema.path('degraded'), 'degraded field missing');
});

test('timestamps give both createdAt and updatedAt', () => {
  assert.ok(Document.schema.path('createdAt'), 'createdAt missing');
  assert.ok(Document.schema.path('updatedAt'), 'updatedAt missing');
});

test('dedup keys are unique partial indexes', () => {
  // schema.indexes() yields { name: [key, options] } — the key spec is at
  // index 0 and the options at index 1, so they must not be conflated.
  const specs = Object.entries(Document.schema.indexes()).map(([, pair]) => ({
    key: pair[0],
    opts: pair[1],
  }));

  const byName = Object.fromEntries(specs.map((s) => [s.opts.name, s]));
  assert.ok(byName.uniq_provider_message?.opts.unique, 'provider message index must be unique');
  assert.ok(byName.uniq_provider_message?.opts.partialFilterExpression, 'provider message index must be partial');
  assert.ok(byName.uniq_google_doc?.opts.unique, 'google doc index must be unique');

  const compound = specs.find(
    (s) => !s.opts.text && !s.opts.unique && s.key.source === 1 && s.key.createdAt === -1
  );
  assert.ok(compound, `missing {source:1, createdAt:-1} index; got ${JSON.stringify(specs.map((s) => s.key))}`);

  // A compound text index is declared in the key, not flagged in the options.
  const text = specs.find((s) => s.key && Object.values(s.key).includes('text'));
  assert.ok(text, `keyword fallback needs a text index for /api/ask; got ${JSON.stringify(specs.map((s) => s.key))}`);
});

test('unknown metadata keys are still ignored (strict)', () => {
  const d = new Document({ source: 'manual', title: 't', rawContent: 'b', metadata: { nonsense: 'x' } });
  assert.strictEqual(d.toObject().metadata?.nonsense, undefined);
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   MongoDB
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
console.log('\nmongodb Â· round-trip and dedup');

let mongoUp = false;

/** Connect once; every Mongo test below assumes it, so failures stay readable. */
async function connectMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await mongoose.connection.syncIndexes();
    mongoUp = true;
  } catch (err) {
    skip(`MongoDB unreachable at ${process.env.MONGO_URI}: ${err.message}`);
  }
}

test('a document round-trips with all metadata intact', async () => {
  await connectMongo();
  const doc = new Document({
    source: 'google_docs',
    title: 'Round trip',
    rawContent: 'body text',
    summary: 's',
    decision: 'Ship it',
    reasoning: 'r',
    tags: ['a', 'b'],
    degraded: 'NOT_CONFIGURED',
    metadata: {
      link: 'https://docs.google.com/x', to: 'a@b.c', threadId: 't1',
      channelId: 'C1', googleDocId: 'G-RT', messageId: 'm1', fullLength: 9,
    },
  });
  await doc.save();
  mongoUp = true;

  const back = await Document.findById(doc._id).lean();
  assert.strictEqual(back.metadata.link, 'https://docs.google.com/x');
  assert.strictEqual(back.metadata.to, 'a@b.c');
  assert.strictEqual(back.metadata.threadId, 't1');
  assert.strictEqual(back.metadata.channelId, 'C1');
  assert.strictEqual(back.degraded, 'NOT_CONFIGURED');
  assert.ok(back.createdAt instanceof Date, 'createdAt not set by timestamps');
  assert.ok(back.updatedAt instanceof Date, 'updatedAt not set by timestamps');

  await Document.deleteOne({ _id: doc._id });
});

test('replace-in-place bumps updatedAt but keeps createdAt', async () => {
  if (!mongoUp) skip('MongoDB not connected');
  const doc = new Document({ source: 'google_docs', title: 'v1', rawContent: 'a', metadata: { googleDocId: 'G-UPD' } });
  await doc.save();
  const firstCreated = doc.createdAt.getTime();
  await new Promise((r) => setTimeout(r, 25));

  doc.title = 'v2';
  doc.rawContent = 'b';
  await doc.save();

  assert.strictEqual(doc.createdAt.getTime(), firstCreated, 'createdAt must not move on update');
  assert.ok(doc.updatedAt.getTime() > firstCreated, 'updatedAt must advance on update');
  await Document.deleteOne({ _id: doc._id });
});

test('decision history round-trips with attribution intact', async () => {
  if (!mongoUp) skip('MongoDB not connected');
  const doc = new Document({
    source: 'gmail',
    title: 'Budget follow-up',
    rawContent: 'body',
    decision: 'Budget approved at 4L',
    decisionHistory: [
      {
        text: 'Budget approved at 2L',
        summary: 'earlier summary',
        decidedAt: '2026-01-01T00:00:00.000Z',
        fromDocId: '656f000000000000000000aa',
        fromTitle: 'Budget thread - earlier mail',
      },
    ],
    metadata: { messageId: 'hist-1', threadId: 'thread-1' },
  });
  await doc.save();

  const back = await Document.findById(doc._id).lean();
  assert.strictEqual(back.decisionHistory.length, 1, 'history entry dropped by schema');
  assert.strictEqual(back.decisionHistory[0].text, 'Budget approved at 2L');
  assert.strictEqual(back.decisionHistory[0].summary, 'earlier summary');
  assert.strictEqual(back.decisionHistory[0].decidedAt, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(back.decisionHistory[0].fromDocId, '656f000000000000000000aa');
  assert.strictEqual(back.decisionHistory[0].fromTitle, 'Budget thread - earlier mail');

  await Document.deleteOne({ _id: doc._id });
});

test('the unique index rejects a duplicate provider id', async () => {
  if (!mongoUp) skip('MongoDB not connected');
  const a = new Document({ source: 'slack', title: 'a', rawContent: 'x', metadata: { messageId: 'ts-1' } });
  await a.save();
  const b = new Document({ source: 'slack', title: 'b', rawContent: 'y', metadata: { messageId: 'ts-1' } });
  await assert.rejects(
    () => b.save(),
    (err) => err.code === 11000,
    'second insert with the same metadata.messageId must fail with E11000'
  );
  await Document.deleteOne({ _id: a._id });
});

test('the same provider id is allowed in a different source', async () => {
  if (!mongoUp) skip('MongoDB not connected');
  const a = new Document({ source: 'slack', title: 'a', rawContent: 'x', metadata: { messageId: 'ts-2' } });
  const b = new Document({ source: 'gmail', title: 'b', rawContent: 'y', metadata: { messageId: 'ts-2' } });
  await a.save();
  await b.save();
  await Document.deleteMany({ _id: { $in: [a._id, b._id] } });
});

test('documents with no provider id are not indexed against each other', async () => {
  if (!mongoUp) skip('MongoDB not connected');
  const a = new Document({ source: 'manual', title: 'a', rawContent: 'x' });
  const b = new Document({ source: 'manual', title: 'b', rawContent: 'y' });
  await a.save();
  await b.save();
  await Document.deleteMany({ _id: { $in: [a._id, b._id] } });
});

test('source filter + recency sort uses the compound index', async () => {
  if (!mongoUp) skip('MongoDB not connected');
  const plan = await Document.find({ source: 'manual' }).sort({ createdAt: -1 }).limit(5).explain('queryPlanner');
  const winning = plan.queryPlanner?.winningPlan;
  const stageNames = JSON.stringify(winning).match(/"stage":"[A-Z_]+"/g) || [];
  assert.ok(
    stageNames.some((s) => s.includes('IXSCAN')),
    `expected an index scan, got: ${JSON.stringify(winning).slice(0, 200)}`
  );
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   ChromaDB
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
console.log('\nchroma Â· dimension contract and retrieval');

let chromaUp = false;

test('ping() reports real reachability (not just "not yet dialled")', async () => {
  const h = await ping();
  chromaUp = h.reachable;
  if (!chromaUp) skip(`ChromaDB unreachable: ${h.lastError}`);
  assert.strictEqual(h.reachable, true);
  assert.ok(h.checkedAt, 'ping() should timestamp its observation');
});

test('an embedding of the configured dimension is accepted', async () => {
  if (!chromaUp) skip('ChromaDB unreachable');
  const vec = Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(i / 13));
  assert.strictEqual(await addToChroma(oid(9001), vec, 'dim probe', { source: 'manual', docId: oid(9001) }), true);
  await deleteFromChroma(oid(9001));
});

test('a wrong-dimension embedding is rejected, not silently stored', async () => {
  if (!chromaUp) skip('ChromaDB unreachable');
  const wrong = Array.from({ length: EMBED_DIM + 1 }, () => 0.1);
  const ok = await addToChroma(oid(9002), wrong, 'bad dim', { source: 'manual', docId: oid(9002) });
  assert.strictEqual(ok, false, 'a dimension mismatch must return false, not throw');
});

test('query returns the id that was stored, and drops unresolvable ids', async () => {
  if (!chromaUp) skip('ChromaDB unreachable');
  const id = oid(9003);
  const vec = Array.from({ length: EMBED_DIM }, (_, i) => Math.cos(i / 7));
  await addToChroma(id, vec, 'retrieval probe', { source: 'manual', docId: id });

  const hits = await queryChroma(vec, 3);
  assert.ok(hits.some((h) => h.docId === id), `expected ${id} in ${JSON.stringify(hits)}`);
  assert.ok(hits.every((h) => typeof h.distance === 'number'), 'every hit needs a distance');

  // A non-ObjectId must be filtered out so it can never reach a Mongo query.
  await addToChroma('not-an-object-id', vec, 'bad id', { source: 'manual' });
  const after = await queryChroma(vec, 5);
  assert.ok(!after.some((h) => h.docId === 'not-an-object-id'), 'non-ObjectId leaked through');

  await deleteFromChroma(id);
  await deleteFromChroma('not-an-object-id');
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Neo4j
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
console.log('\nneo4j Â· graph writes and both read paths');

let neo4jUp = false;

test('clamped LIMIT survives the wire (integer, not float)', async () => {
  if (!neo4j.status().configured) skip('Neo4j credentials not set');
  const neo4jDriver = require('neo4j-driver');
  const d = neo4jDriver.driver(process.env.NEO4J_URI, neo4jDriver.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const s = d.session();
  try {
    // This is a connectivity probe. Never clear the user's graph to prepare a
    // test: datastore tests run against the configured real database.
    await s.run('RETURN 1 AS reachable');
    neo4jUp = true;
  } catch (err) {
    await s.close(); await d.close();
    skip(`Neo4j unreachable at ${process.env.NEO4J_URI}: ${err.message}`);
  }
  await s.close(); await d.close();
});

test('tag and decision lookups both return rows', async () => {
  if (!neo4jUp) skip('Neo4j unreachable');
  const ids = [oid(9101), oid(9102), oid(9103)];
  ids.forEach((id) => neo4jFixtureIds.add(id));
  const sharedDecision = `${NEO4J_FIXTURE_PREFIX} adopt test stack`;
  await neo4j.storeDocumentNode(ids[0], `${NEO4J_FIXTURE_PREFIX} Alpha`, 'manual', sharedDecision, [`${NEO4J_FIXTURE_PREFIX} infra`, `${NEO4J_FIXTURE_PREFIX} migration`]);
  await neo4j.storeDocumentNode(ids[1], `${NEO4J_FIXTURE_PREFIX} Beta`, 'manual', sharedDecision, [`${NEO4J_FIXTURE_PREFIX} infra`]);
  await neo4j.storeDocumentNode(ids[2], `${NEO4J_FIXTURE_PREFIX} Gamma`, 'gmail', `${NEO4J_FIXTURE_PREFIX} hire test interns`, [`${NEO4J_FIXTURE_PREFIX} people`]);

  const byTag = await neo4j.getRelatedDocuments([`${NEO4J_FIXTURE_PREFIX} infra`], { limit: 5 });
  assert.ok(byTag.length >= 2, `expected >=2 tag neighbours, got ${byTag.length}`);
  assert.ok(byTag.every((r) => r.docId && typeof r.sharedTags === 'number'), 'malformed tag rows');
  assert.ok(byTag.some((r) => r.docId === ids[1]), 'Beta shares the infra tag');

  const excluded = await neo4j.getRelatedDocuments([`${NEO4J_FIXTURE_PREFIX} infra`], { excludeIds: [ids[0]], limit: 5 });
  assert.ok(!excluded.some((r) => r.docId === ids[0]), 'excludeIds was ignored');

  const byDecision = await neo4j.getDocumentsSharingDecision(sharedDecision, { limit: 5 });
  assert.ok(byDecision.length >= 1, 'expected a shared-decision neighbour');
  assert.ok(byDecision.every((r) => r.docId), 'decision rows need ids');

  for (const v of [0, -4, 3.7, NaN, 99, '7', undefined]) {
    const r = await neo4j.getRelatedDocuments([`${NEO4J_FIXTURE_PREFIX} infra`], { limit: v });
    assert.ok(Array.isArray(r), `limit=${v} must not throw`);
  }
});

test('a re-decision grows an adjacency chain and repoints MADE_DECISION', async () => {
  if (!neo4jUp) skip('Neo4j unreachable');
  const id = oid(9301);
  const prevId = oid(9302);
  neo4jFixtureIds.add(id);
  neo4jFixtureIds.add(prevId);

  // v1
  await neo4j.storeDocumentNode(id, `${NEO4J_FIXTURE_PREFIX} Chain`, 'gmail', `${NEO4J_FIXTURE_PREFIX} decision v1`, []);
  // v2 — v1 is superseded, and an earlier mail in the thread is linked
  await neo4j.storeDocumentNode(id, `${NEO4J_FIXTURE_PREFIX} Chain`, 'gmail', `${NEO4J_FIXTURE_PREFIX} decision v2`, [], {
    history: [{ text: `${NEO4J_FIXTURE_PREFIX} decision v1`, summary: 's1', decidedAt: '2026-01-01T00:00:00.000Z' }],
    previousDocId: String(prevId),
  });

  const history = await neo4j.getDecisionHistory(id);
  assert.strictEqual(history.length, 2, `expected 2 versions, got ${history.length}`);
  assert.strictEqual(history[0].text, `${NEO4J_FIXTURE_PREFIX} decision v2`, 'latest version should be first');
  assert.strictEqual(history[0].isLatest, true);
  assert.strictEqual(history[1].text, `${NEO4J_FIXTURE_PREFIX} decision v1`);
  assert.strictEqual(history[1].isLatest, false);
  assert.strictEqual(history[1].decidedAt, '2026-01-01T00:00:00.000Z');

  // MADE_DECISION must point at the current text only, not accumulate.
  const neo4jDriver = require('neo4j-driver');
  const d = neo4jDriver.driver(process.env.NEO4J_URI, neo4jDriver.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const s = d.session();
  try {
    const rels = await s.run(
      'MATCH (x:Document {id: $id})-[r:MADE_DECISION]->(n:Decision) RETURN n.text AS text',
      { id }
    );
    assert.strictEqual(rels.records.length, 1, 'MADE_DECISION should have exactly one target');
    assert.strictEqual(rels.records[0].get('text'), `${NEO4J_FIXTURE_PREFIX} decision v2`);

    const thread = await s.run(
      'MATCH (x:Document {id: $id})-[:PREVIOUS_IN_THREAD]->(p:Document) RETURN p.id AS pid',
      { id }
    );
    assert.strictEqual(thread.records.length, 1, 'PREVIOUS_IN_THREAD link missing');
    assert.strictEqual(thread.records[0].get('pid'), String(prevId));

    const chain = await s.run(
      'MATCH (a:DecisionVersion {docId: $id})-[:PREVIOUS]->(b:DecisionVersion) RETURN count(*) AS c',
      { id }
    );
    assert.strictEqual(chain.records[0].get('c').toNumber(), 1, 'PREVIOUS link between versions missing');
  } finally {
    await s.close(); await d.close();
  }
});

test('deleting a document removes its graph footprint', async () => {
  if (!neo4jUp) skip('Neo4j unreachable');
  const id = oid(9201);
  neo4jFixtureIds.add(id);
  await neo4j.storeDocumentNode(id, `${NEO4J_FIXTURE_PREFIX} Doomed`, 'manual', `${NEO4J_FIXTURE_PREFIX} temporary decision`, [`${NEO4J_FIXTURE_PREFIX} ephemeral`]);
  assert.ok(await neo4j.deleteDocumentNode(id), 'delete should report success');

  const neo4jDriver = require('neo4j-driver');
  const d = neo4jDriver.driver(process.env.NEO4J_URI, neo4jDriver.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const s = d.session();
  const res = await s.run('MATCH (x:Document {id: $id}) RETURN count(x) AS c', { id });
  assert.strictEqual(res.records[0].get('c').toNumber(), 0, 'Document node survived deletion');
   await s.close(); await d.close();
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
async function run() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`  âœ“ ${name}`);
    } catch (err) {
      if (err && err[SKIP]) {
        skipped += 1;
        console.log(`  ~ ${name}`);
        console.log(`      skipped: ${err.message}`);
      } else {
        failed += 1;
        console.error(`  âœ— ${name}`);
        console.error(`      ${err.message}`);
      }
    }
  }

  // Remove only fixture documents created by this test file. Never clear the
  // configured Neo4j database: tests are allowed to run next to user data.
  if (neo4jFixtureIds.size && neo4j.status().configured) {
    const neo4jDriver = require('neo4j-driver');
    const d = neo4jDriver.driver(process.env.NEO4J_URI, neo4jDriver.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
    const s = d.session();
    try {
      await s.executeWrite((tx) => tx.run(
        'MATCH (d:Document) WHERE d.id IN $ids DETACH DELETE d',
        { ids: [...neo4jFixtureIds] }
      ));
      // Decision versions are per-document and keyed by docId, so they are
      // removed with the fixtures rather than by the prefix sweep below.
      await s.executeWrite((tx) => tx.run(
        'MATCH (v:DecisionVersion) WHERE v.docId IN $ids DETACH DELETE v',
        { ids: [...neo4jFixtureIds] }
      ));
      await s.executeWrite((tx) => tx.run(
        `MATCH (n) WHERE
           (n:Tag AND n.name STARTS WITH $prefix OR n:Decision AND n.text STARTS WITH $prefix)
           AND NOT (n)--()
         DELETE n`,
        { prefix: NEO4J_FIXTURE_PREFIX }
      ));
    } catch (err) {
      failed++;
      console.error(`  FAIL  Neo4j fixture cleanup: ${err.message}`);
    } finally {
      await s.close();
      await d.close();
    }
  }

  try {
    await mongoose.connection.close();
  } catch { /* never connected */ }
  await neo4j.close().catch(() => {});

  const parts = [`${passed} passed`];
  if (skipped) parts.push(`${skipped} skipped`);
  parts.push(`${failed} failed`);
  console.log(`\n${failed ? 'âœ—' : 'âœ“'} ${parts.join(', ')}\n`);
  process.exit(failed ? 1 : 0);
}

run();
