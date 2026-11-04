/**
 * Backfill missing or stale Chroma vectors from Mongo. New vectors include
 * title, summary, decisions, tags and source metadata, not just rawContent.
 * Existing vectors are rebuilt only when --apply is explicitly passed.
 *
 *   node backfill_vectors.js            # report only
 *   node backfill_vectors.js --apply    # embed the missing ones
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Document = require('./models/Document');
const { getEmbedding } = require('./services/aiService');
const { buildIndexText, VECTOR_INDEX_VERSION } = require('./services/retrieval');
const { addToChroma } = require('./services/chromaService');

const CHROMA = process.env.CHROMA_URL || 'http://localhost:8000';
const TENANT = process.env.CHROMA_TENANT || 'default_tenant';
const DATABASE = process.env.CHROMA_DATABASE || 'default_database';
const COLLECTION = process.env.CHROMA_COLLECTION || 'orgmind_gemini_docs_v1';
const APPLY = process.argv.includes('--apply');
const readFlag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
};
const SOURCE_FILTER = readFlag('--source');
const LIMIT = Math.max(0, Number(readFlag('--limit')) || 0);

/** Chroma v2 REST (v1 is unimplemented on this server). */
const base = () => `${CHROMA}/api/v2/tenants/${TENANT}/databases/${DATABASE}`;

async function collectionId() {
  const res = await fetch(`${base()}/collections`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body?.collections || [];
  const col = list.find((c) => c.name === COLLECTION);
  if (!col) throw new Error(`collection ${COLLECTION} not found at ${CHROMA}`);
  return col.id;
}

/** Existing vector metadata keyed by canonical Mongo document id. */
async function chromaRecords() {
  const id = await collectionId();
  const res = await fetch(`${base()}/collections/${id}/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100000, include: ['metadatas'] }),
  });
  const got = await res.json();
  if (!res.ok) throw new Error(`chroma get ${res.status}: ${JSON.stringify(got)}`);
  const records = new Map();
  (got.ids || []).forEach((idValue, index) => {
    const metadata = got.metadatas?.[index] || {};
    records.set(String(metadata.docId || idValue), metadata);
  });
  return records;
}

(async () => {
  const existing = await chromaRecords();
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const docs = await Document.find({}).select('source title rawContent summary decision reasoning tags decisionHistory metadata').lean();

  const allStale = docs.filter((d) =>
    existing.get(d._id.toString())?.embeddingVersion !== VECTOR_INDEX_VERSION
  );
  const eligible = SOURCE_FILTER ? allStale.filter((d) => d.source === SOURCE_FILTER) : allStale;
  const stale = LIMIT ? eligible.slice(0, LIMIT) : eligible;
  const current = docs.filter((d) =>
    existing.get(d._id.toString())?.embeddingVersion === VECTOR_INDEX_VERSION
  ).length;
  console.log(`  documents      : ${docs.length}`);
  console.log(`  current vectors: ${current}`);
  console.log(`  rebuild needed : ${allStale.length}`);
  console.log(`  selected       : ${stale.length}${SOURCE_FILTER ? ` (${SOURCE_FILTER})` : ''}`);

  if (stale.length) {
    const bySrc = {};
    for (const d of stale) bySrc[d.source] = (bySrc[d.source] || 0) + 1;
    for (const [k, v] of Object.entries(bySrc)) console.log(`    ${k.padEnd(14)}${v}`);
  }

  if (!APPLY) {
    console.log('  DRY RUN - pass --apply to re-embed selected stale and missing vectors.');
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let failed = 0;
  for (const d of stale) {
    const text = buildIndexText(d);
    try {
      const emb = await getEmbedding(text, { task: 'document' });
      if (emb.length > 0) {
        const ok = await addToChroma(String(d._id), emb, text, {
          source: d.source,
          title: d.title,
          docId: String(d._id),
          embeddingVersion: VECTOR_INDEX_VERSION,
        });
        if (ok) done += 1;
        else failed += 1;
      } else failed += 1;
    } catch (err) {
      failed += 1;
      console.log(`    skip ${d._id}: ${err.message}`);
    }
  }
  console.log(`  REBUILT ${done}/${stale.length}  (failed ${failed})`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error('  FAILED: ' + e.message);
  process.exit(1);
});
