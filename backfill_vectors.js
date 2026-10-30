/**
 * Backfill Chroma vectors for documents stored in Mongo that never got an
 * embedding. The ingest path treats a failed embedding as non-fatal and falls
 * back to keyword search, so a burst of embedding 429s leaves docs in Mongo
 * with no vector. This diffs Mongo against Chroma and embeds only the gap.
 *
 *   node backfill_vectors.js            # report only
 *   node backfill_vectors.js --apply    # embed the missing ones
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Document = require('./models/Document');
const { getEmbedding } = require('./services/aiService');

const CHROMA = process.env.CHROMA_URL || 'http://localhost:8000';
const TENANT = process.env.CHROMA_TENANT || 'default_tenant';
const DATABASE = process.env.CHROMA_DATABASE || 'default_database';
const APPLY = process.argv.includes('--apply');

/** Chroma v2 REST (v1 is unimplemented on this server). */
const base = () => `${CHROMA}/api/v2/tenants/${TENANT}/databases/${DATABASE}`;

async function collectionId() {
  const res = await fetch(`${base()}/collections`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body?.collections || [];
  const col = list.find((c) => c.name === process.env.CHROMA_COLLECTION);
  if (!col) throw new Error(`collection ${process.env.CHROMA_COLLECTION} not found at ${CHROMA}`);
  return col.id;
}

/** Every id already stored in the collection. */
async function chromaIds() {
  const id = await collectionId();
  const res = await fetch(`${base()}/collections/${id}/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100000, include: [] }),
  });
  const got = await res.json();
  if (!res.ok) throw new Error(`chroma get ${res.status}: ${JSON.stringify(got)}`);
  return new Set((got.ids || []).map(String));
}

async function addVector(collection, docId, embedding, content, metadata) {
  const res = await fetch(`${base()}/collections/${collection}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids: [String(docId)],
      embeddings: [embedding],
      documents: [content],
      metadatas: [metadata],
    }),
  });
  if (!res.ok) throw new Error(`chroma ${res.status}: ${await res.text()}`);
}

(async () => {
  const have = await chromaIds();
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const docs = await Document.find({}).select('source title rawContent').lean();

  const missing = docs.filter((d) => !have.has(d._id.toString()));
  console.log(`  documents      : ${docs.length}`);
  console.log(`  with vectors   : ${have.size}`);
  console.log(`  missing vectors: ${missing.length}`);

  if (missing.length) {
    const bySrc = {};
    for (const d of missing) bySrc[d.source] = (bySrc[d.source] || 0) + 1;
    for (const [k, v] of Object.entries(bySrc)) console.log(`    ${k.padEnd(14)}${v}`);
  }

  if (!APPLY) {
    console.log('  DRY RUN - pass --apply to embed.');
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let failed = 0;
  const collection = await collectionId();
  for (const d of missing) {
    const text = d.rawContent || d.title || '';
    try {
      const emb = await getEmbedding(text, { task: 'document' });
      if (emb.length > 0) {
        await addVector(collection, d._id, emb, text, { source: d.source, title: d.title, docId: d._id.toString() });
        done += 1;
      } else failed += 1;
    } catch (err) {
      failed += 1;
      console.log(`    skip ${d._id}: ${err.message}`);
    }
  }
  console.log(`  EMBEDDED ${done}/${missing.length}  (failed ${failed})`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error('  FAILED: ' + e.message);
  process.exit(1);
});
