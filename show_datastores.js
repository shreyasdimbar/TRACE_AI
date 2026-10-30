/**
 * show_datastores.js — a printable tour of every storage layer.
 *
 *   npm run show:db
 *
 * Compass and the Neo4j browser are good for poking around, but neither answers
 * "what is actually in here?" in one glance. This prints a readable summary of
 * all three layers side by side, which is also the fastest thing to have open
 * beside you during a demo or a viva.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const neo4j = require('neo4j-driver');

const Document = require('./models/Document');
const chroma = require('./services/chromaService');
const neo4jService = require('./services/neo4jService');
const googleAuth = require('./services/googleAuth');

const line = (c = '=') => console.log(c.repeat(78));
const row = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);
const trunc = (s, n = 58) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));

(async () => {
  line();
  console.log('  Trace.AI — datastore tour');
  line();

  /* ── MongoDB ─────────────────────────────────────────────── */
  console.log('\n  MONGODB  ' + process.env.MONGO_URI);
  line('-');
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });

    const total = await Document.countDocuments();
    const users = await mongoose.connection.collection('users').countDocuments();
    const bySource = await Document.aggregate([{ $group: { _id: '$source', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
    const degraded = await Document.countDocuments({ degraded: { $ne: null } });
    const withTags = await Document.countDocuments({ tags: { $exists: true, $ne: [] } });
    const withDecision = await Document.countDocuments({ decision: { $exists: true, $ne: 'No decision' } });

    row('database', mongoose.connection.name);
    row('documents', total);
    row('users', users);
    row('by source', bySource.map((r) => `${r._id}=${r.n}`).join('  ') || '—');
    row('with tags', `${withTags}/${total}`);
    row('with a decision', `${withDecision}/${total}`);
    row('AI degraded', `${degraded}/${total}`);

    const indexes = await mongoose.connection.collection('documents').indexes();
    console.log('\n  indexes');
    for (const ix of indexes) {
      const kind = ix.textIndexVersion ? 'TEXT' : ix.unique ? 'UNIQUE' : 'index';
      const partial = ix.partialFilterExpression ? ' partial' : '';
      console.log(`    ${kind.padEnd(6)} ${JSON.stringify(ix.key)}${partial}`);
    }

    const docs = await Document.find({}, { title: 1, source: 1, decision: 1, tags: 1, summary: 1 })
      .sort({ createdAt: -1 }).limit(5).lean();
    if (docs.length) {
      console.log('\n  5 most recent');
      for (const d of docs) {
        console.log(`\n    [${d.source}] ${trunc(d.title, 70)}`);
        console.log(`      summary  : ${trunc(d.summary, 70)}`);
        console.log(`      decision : ${trunc(d.decision, 70)}`);
        console.log(`      tags     : ${JSON.stringify(d.tags || [])}`);
      }
    }
  } catch (err) {
    row('ERROR', err.message);
  }

  /* ── ChromaDB ────────────────────────────────────────────── */
  console.log('\n\n  CHROMADB  ' + (process.env.CHROMA_URL || 'http://localhost:8000'));
  line('-');
  try {
    const p = await chroma.ping();
    const count = await chroma.countIndexed();
    row('collection', p.collection);
    row('reachable', p.reachable);
    row('embed model', 'gemini-embedding-001');
    row('dimensions', p.embedDim);
    row('vectors stored', count ?? 0);
    if (p.lastError) row('last error', trunc(p.lastError, 60));
  } catch (err) {
    row('ERROR', err.message);
  }

  /* ── Neo4j ───────────────────────────────────────────────── */
  console.log('\n\n  NEO4J  ' + process.env.NEO4J_URI);
  line('-');
  try {
    if (!neo4jService.status().configured) {
      row('status', 'not configured');
    } else {
      const uri = process.env.NEO4J_URI;
      const driver = neo4j.driver(uri, neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
      const session = driver.session();
      const nodes = await session.run('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS c ORDER BY label');
      const rels = await session.run('MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c ORDER BY t');
      row('total nodes', await neo4jService.countNodes());
      console.log('\n  nodes');
      for (const r of nodes.records) console.log(`    :${String(r.get('label')).padEnd(12)} ${r.get('c').toNumber()}`);
      console.log('\n  relationships');
      for (const r of rels.records) console.log(`    -[${String(r.get('t')).padEnd(15)}]-> ${r.get('c').toNumber()}`);

      const tags = await session.run('MATCH (t:Tag) RETURN t.name AS n, count(*) AS c ORDER BY c DESC LIMIT 8');
      if (tags.records.length) {
        console.log('\n  most common tags');
        for (const r of tags.records) console.log(`    #${String(r.get('n')).padEnd(22)} ${r.get('c').toNumber()} document(s)`);
      }
      await session.close();
      await driver.close();
    }
  } catch (err) {
    row('ERROR', err.message.slice(0, 70));
  }

  /* ── Integrations ────────────────────────────────────────── */
  console.log('\n\n  INTEGRATIONS');
  line('-');
  const g = googleAuth.status();
  row('google', g.connected ? 'connected' : 'not connected');
  row('drive folder', g.driveFolderConfigured ? g.driveFolderConfigured === true ? 'configured' : '' : 'missing');
  row('slack', process.env.SLACK_BOT_TOKEN ? 'configured' : 'missing');

  const ai = require('./services/aiService').describe();
  row('ai model', ai.model);
  row('ai embed', ai.embedModel);

  line();
  console.log('\n  GUIs:  Neo4j browser  http://localhost:7474   (graph, already running)');
  console.log('         MongoDB Compass  connect to  mongodb://localhost:27017/orgmind');
  line();
  console.log('');

  await mongoose.connection.close().catch(() => {});
  await neo4jService.close().catch(() => {});
  process.exit(0);
})();
