/**
 * chromaService — vector store for semantic retrieval.
 *
 * The collection name encodes the embedding model, because ChromaDB pins a
 * dimension per collection. Mixing providers (or model versions) inside one
 * collection produces dimension-mismatch errors that are easy to misread, so
 * the name changes whenever the embedding model does.
 *
 * Every method fails soft: retrieval degrades to keyword search rather than
 * taking down ingest. Failures are recorded on `status()` so the health
 * endpoint and the ask route can report degraded mode honestly.
 */

const { ChromaClient } = require('chromadb');

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const COLLECTION = process.env.CHROMA_COLLECTION || 'orgmind_gemini_docs_v1';
const EMBED_DIM = Number(process.env.CHROMA_EMBED_DIM || 768); // text-embedding-004

let client = null;
let collection = null;
let connecting = null;

const state = {
  lastError: null,
  lastErrorAt: null,
  lastOkAt: null,
  disabled: false,
};

function noteFailure(err) {
  state.lastError = err?.message || String(err);
  state.lastErrorAt = new Date().toISOString();
  // Drop the cached handles so the next call re-dials.
  collection = null;
  client = null;
  connecting = null;
}

function noteSuccess() {
  state.lastOkAt = new Date().toISOString();
  if (state.lastError) {
    state.lastError = null;
  }
}

function status() {
  return {
    reachable: Boolean(collection),
    collection: COLLECTION,
    embedDim: EMBED_DIM,
    disabled: state.disabled,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    lastOkAt: state.lastOkAt,
  };
}

/**
 * Truthful reachability for the health endpoint.
 *
 * status() on its own reports reachable:false until something in the process
 * first dials the server, so a perfectly healthy install reads as an outage on
 * a cold start. This actually dials, so /health reports observation rather than
 * the client's laziness. Cheap: getCollection() short-circuits once connected.
 */
async function ping() {
  if (state.disabled) {
    return { ...status(), reachable: false, checkedAt: new Date().toISOString() };
  }
  const col = await getCollection();
  return {
    ...status(),
    reachable: Boolean(col),
    checkedAt: new Date().toISOString(),
  };
}

async function getCollection() {
  if (state.disabled) return null;
  if (collection) return collection;
  // Collapse concurrent first-call races into a single connection attempt.
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      client = client || new ChromaClient({ path: CHROMA_URL });
      collection = await client.getOrCreateCollection({
        name: COLLECTION,
        metadata: {
          'hnsw:space': 'cosine',
          'embedding_provider': 'gemini',
          'embedding_dim': String(EMBED_DIM),
        },
      });
      noteSuccess();
      console.log(`[chroma] collection "${COLLECTION}" ready (dim ${EMBED_DIM})`);
      return collection;
    } catch (err) {
      state.lastError = err?.message || String(err);
      state.lastErrorAt = new Date().toISOString();
      console.warn(`[chroma] unavailable at ${CHROMA_URL} — falling back to keyword search (${state.lastError})`);
      collection = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** Shapes a Chroma dimension error into something an operator can act on. */
function describeAddError(err) {
  const msg = err?.message || String(err);
  if (/dimension/i.test(msg)) {
    return `Embedding dimension mismatch for collection "${COLLECTION}" (expected ${EMBED_DIM}). ` +
      `Run "npm run reset" to drop the stale collection, or set CHROMA_COLLECTION to a fresh name.`;
  }
  return msg;
}

function assertDim(embedding) {
  if (embedding.length !== EMBED_DIM) {
    throw new Error(
      `Embedding has ${embedding.length} dimensions but collection "${COLLECTION}" expects ${EMBED_DIM}. ` +
      `Check GEMINI_EMBED_MODEL.`
    );
  }
}

async function addToChroma(docId, embedding, content, metadata = {}) {
  if (!Array.isArray(embedding) || embedding.length === 0) return false;

  const col = await getCollection();
  if (!col) return false;

  try {
    assertDim(embedding);
    // upsert, not add: re-ingesting the same document must not throw on a
    // duplicate id (this happens every time a Google Doc is edited).
    await col.upsert({
      ids: [String(docId)],
      embeddings: [embedding],
      documents: [String(content ?? '')],
      metadatas: [metadata],
    });
    noteSuccess();
    return true;
  } catch (err) {
    console.warn(`[chroma] upsert failed: ${describeAddError(err)}`);
    noteFailure(err);
    return false;
  }
}

async function deleteFromChroma(docId) {
  const col = await getCollection();
  if (!col) return false;
  try {
    await col.delete({ ids: [String(docId)] });
    noteSuccess();
    return true;
  } catch (err) {
    // Deleting an id that was never indexed is not a real failure.
    console.warn(`[chroma] delete failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Returns [{ docId, distance }] ordered by ascending distance, or [] when the
 * store is unreachable so the caller can fall back to keyword search.
 */
async function queryChroma(embedding, nResults = 6) {
  if (!Array.isArray(embedding) || embedding.length === 0) return [];

  const col = await getCollection();
  if (!col) return [];

  try {
    assertDim(embedding);
    const res = await col.query({
      queryEmbeddings: [embedding],
      nResults,
      include: ['documents', 'metadatas', 'distances'],
    });

    const ids = res?.ids?.[0] || [];
    const distances = res?.distances?.[0] || [];
    return ids
      .map((docId, i) => ({ docId: String(docId), distance: distances[i] }))
      .filter((r) => mongooseIsValidId(r.docId));
  } catch (err) {
    console.warn(`[chroma] query failed: ${describeAddError(err)}`);
    noteFailure(err);
    return [];
  }
}

/**
 * Chroma ids come from Mongo ObjectIds. Anything else cannot be dereferenced,
 * so it is dropped rather than passed to a Mongo query that would throw.
 */
function mongooseIsValidId(id) {
  const { Types } = require('mongoose');
  return Types.ObjectId.isValid(id);
}

async function countIndexed() {
  const col = await getCollection();
  if (!col) return null;
  try {
    return await col.count();
  } catch {
    return null;
  }
}

module.exports = {
  addToChroma,
  deleteFromChroma,
  queryChroma,
  countIndexed,
  status,
  ping,
  COLLECTION,
  EMBED_DIM,
};
