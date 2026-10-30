/**
 * reset.js — wipe every storage layer.
 *
 *   npm run reset
 *
 * Destructive. MongoDB documents, the Chroma collection, and the Neo4j graph
 * are all cleared. Users are kept unless --all is passed, because losing the
 * login is rarely what you want when you are only clearing ingested content.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const neo4j = require('neo4j-driver');
const { ChromaClient } = require('chromadb');

const { COLLECTION } = require('./services/chromaService');
const neo4jService = require('./services/neo4jService');

const wipeUsers = process.argv.includes('--all');
const confirm = process.argv.includes('--yes') || process.argv.includes('-y');

function line(msg = '') {
  console.log(msg);
}

async function wipeMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    line('⚠️  MONGO_URI not set — skipping MongoDB');
    return;
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  // Delete through the models so registered indexes/hooks are respected.
  // These modules export the Mongoose model directly, not { Document }.
  const Doc = require('./models/Document');
  const docs = await Doc.deleteMany({});
  line(`✅ MongoDB: deleted ${docs.deletedCount} documents`);

  if (wipeUsers) {
    const User = require('./models/User');
    const users = await User.deleteMany({});
    line(`✅ MongoDB: deleted ${users.deletedCount} users`);
  } else {
    line('ℹ️  Users kept (pass --all to delete them too)');
  }
}

async function wipeChroma() {
  const url = process.env.CHROMA_URL || 'http://localhost:8000';
  try {
    const client = new ChromaClient({ path: url });
    await client.deleteCollection({ name: COLLECTION });
    line(`✅ ChromaDB: deleted collection "${COLLECTION}"`);
  } catch (err) {
    line(`ℹ️  ChromaDB: nothing to delete or unreachable at ${url} (${err.message})`);
  }
}

async function wipeNeo4j() {
  if (!neo4jService.status().configured) {
    line('⚠️  Neo4j credentials not set — skipping graph');
    return;
  }
  try {
    const driver = neo4j.driver(
      process.env.NEO4J_URI,
      neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD)
    );
    const session = driver.session();
    try {
      const result = await session.run('MATCH (n) DETACH DELETE n');
      const deleted = result.summary?.counters?.nodesDeleted ?? 0;
      line(`✅ Neo4j: deleted ${deleted} nodes and all relationships`);
    } finally {
      await session.close();
    }
    await driver.close();
  } catch (err) {
    line(`❌ Neo4J: ${err.message}`);
  }
}

(async () => {
  if (!confirm) {
    line('This will permanently delete all ingested data.');
    line('Re-run with --yes to proceed, or --all to also delete user accounts.');
    process.exit(1);
  }

  line('🧹 Wiping all storage layers...\n');

  const results = await Promise.allSettled([wipeMongo(), wipeChroma(), wipeNeo4j()]);

  const failures = results.filter((r) => r.status === 'rejected');
  for (const f of failures) line(`❌ ${f.reason?.message || f.reason}`);

  await mongoose.disconnect().catch(() => {});

  line('\nDone. Restart the server to re-create an empty Chroma collection.');
  process.exit(failures.length ? 1 : 0);
})();
