/**
 * show_vectors.js - a readable tour of the vector store.
 *
 *   npm run show:vectors                       (default question)
 *   npm run show:vectors -- "your question"    (custom question)
 *
 * ChromaDB 1.5.7 ships no web frontend (GET / returns 404; only the Swagger docs
 * at /docs remain), and the Swagger UI documents the API rather than showing what
 * is actually stored. This prints the collection inventory, a real stored vector,
 * and - most usefully - a live semantic search with cosine distances.
 *
 * Output is deliberately ASCII-only: the Windows console is cp1252 and renders
 * box drawing and em dashes as mojibake.
 */

require('dotenv').config();

const { ChromaClient } = require('chromadb');
const { getEmbedding } = require('./services/aiService');

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const COLLECTION = process.env.CHROMA_COLLECTION || 'orgmind_gemini_docs_v2';

const line = (c = '=') => console.log(c.repeat(78));
const trunc = (s, n = 60) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '...' : String(s ?? ''));

/** Similarity bar. distance 0 = identical, so the bar fills as it gets worse. */
function bar(frac, width = 30) {
  const filled = Math.max(0, Math.min(width, Math.round((1 - frac) * width)));
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

async function main() {
  line();
  console.log('  Trace.AI - vector store');
  line();

  const client = new ChromaClient({ path: CHROMA_URL });

  /* -- Inventory ------------------------------------------------ */
  console.log('\n  COLLECTIONS');
  line('-');

  // chromadb JS 1.8.x returns a plain array of names from listCollections(),
  // not the { ids, collections } envelope older versions returned.
  const listed = await client.listCollections();
  const names = Array.isArray(listed) ? listed : listed?.ids || [];

  const active = names.find((n) => n === COLLECTION) || null;
  if (!active) {
    console.log(`\n  active collection "${COLLECTION}" does not exist.`);
    console.log(`  found: ${names.join(', ') || '(none)'}`);
    process.exit(0);
  }

  for (const name of names) {
    let count = 'unavailable';
    let meta = null;
    try {
      const col = await client.getCollection({ name });
      count = await col.count();
      meta = col.metadata || null;
    } catch { /* keep the placeholder */ }

    const isActive = name === COLLECTION;
    console.log(`\n  ${isActive ? '>' : ' '} ${name}${isActive ? '   (active)' : ''}`);
    console.log(`      vectors   : ${count}`);
    if (meta && meta.embedding_provider) console.log(`      provider  : ${meta.embedding_provider}`);
    if (meta && meta.embedding_dim) console.log(`      embed dim : ${meta.embedding_dim}`);
    if (meta && meta['hnsw:space']) console.log(`      space     : ${meta['hnsw:space']}`);
  }

  const col = await client.getCollection({ name: COLLECTION });
  const total = await col.count();

  if (total === 0) {
    console.log(`\n  "${COLLECTION}" is empty. Run an ingest to populate it.`);
    process.exit(0);
  }

  /* -- A stored vector ------------------------------------------ */
  console.log('\n\n  A STORED VECTOR');
  line('-');
  const sample = await col.get({ limit: 1, include: ['documents', 'metadatas', 'embeddings'] });
  const vec = sample.embeddings?.[0];

  console.log(`  id        ${sample.ids[0]}`);
  console.log(`  title     ${trunc(sample.metadatas?.[0]?.title, 62)}`);
  console.log(`  source    ${sample.metadatas?.[0]?.source}`);
  console.log(`  content   ${trunc(sample.documents?.[0], 62)}`);

  if (vec && Array.isArray(vec)) {
    const head = vec.slice(0, 8).map((n) => n.toFixed(4)).join(', ');
    const norm = Math.sqrt(vec.reduce((a, n) => a + n * n, 0));
    const mean = vec.reduce((a, n) => a + n, 0) / vec.length;
    console.log(`\n  vector    ${vec.length} numbers. First 8 of ${vec.length}:`);
    console.log(`            [${head}, ...]`);
    console.log(`            L2 norm ${norm.toFixed(4)}   mean ${mean.toFixed(6)}`);
  }

  /* -- Everything stored ---------------------------------------- */
  console.log('\n\n  CONTENTS');
  line('-');
  const rows = await col.get({ include: ['documents', 'metadatas'] });
  for (let i = 0; i < rows.ids.length; i++) {
    console.log(`\n  [${i + 1}] ${trunc(rows.metadatas?.[i]?.title, 66)}`);
    console.log(`      ${trunc(rows.documents?.[i], 70)}`);
  }

  /* -- Live semantic search ------------------------------------- */
  const question = process.argv[2] || 'What did we decide about the architecture and the database?';
  console.log('\n\n  LIVE SEMANTIC SEARCH');
  line('-');
  console.log(`  question : "${question}"`);

  const t0 = Date.now();
  const qvec = await getEmbedding(question, { task: 'query' });

  if (!qvec.length) {
    console.log('  could not embed the question (GEMINI_API_KEY issue, or the model is throttled)');
    process.exit(0);
  }
  console.log(`  embedded : ${qvec.length} numbers in ${Date.now() - t0}ms  (task=query)`);
  console.log(`  searching : top 5 of ${total} by cosine distance\n`);

  const res = await col.query({
    queryEmbeddings: [qvec],
    nResults: 5,
    include: ['documents', 'metadatas', 'distances'],
  });

  res.ids[0].forEach((rid, i) => {
    const d = res.distances[0][i];
    console.log(`  ${i + 1}. distance ${d.toFixed(4)}  ${bar(d)}`);
    console.log(`     ${trunc(res.metadatas?.[0]?.[i]?.title, 62)}`);
    console.log(`     ${trunc(res.documents?.[0]?.[i], 66)}`);
    console.log(`     id ${rid}\n`);
  });

  line();
  console.log('  Swagger API docs:  http://localhost:8000/docs');
  line();
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  FAILED:', err.message, '\n');
  process.exit(1);
});
