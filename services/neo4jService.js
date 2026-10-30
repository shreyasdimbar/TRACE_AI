/**
 * neo4jService — knowledge graph side of retrieval.
 *
 * Graph shape:
 *   (:Document)-[:HAS_TAG]->(:Tag)
 *   (:Document)-[:MADE_DECISION]->(:Decision)
 *   (:Document)-[:IN_SOURCE]->(:Source)
 *
 * Writes are batched with UNWIND (one round-trip instead of one per tag) and
 * are best-effort: if Neo4j is down, ingest still succeeds.
 */

const neo4j = require('neo4j-driver');

const URI = process.env.NEO4J_URI;
const USERNAME = process.env.NEO4J_USERNAME;
const PASSWORD = process.env.NEO4J_PASSWORD;

let driver = null;
let disabled = false;
let indexesEnsured = false;

const state = { lastError: null, lastOkAt: null };

function isConfigured() {
  return Boolean(URI && USERNAME && PASSWORD);
}

function getDriver() {
  if (disabled) return null;
  if (!isConfigured()) {
    disabled = true;
    console.warn('[neo4j] credentials not set — graph features disabled');
    return null;
  }
  if (!driver) {
    try {
      driver = neo4j.driver(URI, neo4j.auth.basic(USERNAME, PASSWORD), {
        maxConnectionPoolSize: 20,
        connectionAcquisitionTimeout: 8000,
      });
    } catch (err) {
      disabled = true;
      state.lastError = err.message;
      console.warn(`[neo4j] driver init failed, graph disabled: ${err.message}`);
      return null;
    }
  }
  return driver;
}

async function withSession(fn) {
  const d = getDriver();
  if (!d) return null;
  const session = d.session();
  try {
    const out = await fn(session);
    state.lastError = null;
    state.lastOkAt = new Date().toISOString();
    return out;
  } finally {
    await session.close().catch(() => {});
  }
}

async function ensureIndexes() {
  if (indexesEnsured) return;
  const statements = [
    'CREATE INDEX document_id IF NOT EXISTS FOR (d:Document) ON (d.id)',
    'CREATE INDEX tag_name IF NOT EXISTS FOR (t:Tag) ON (t.name)',
    'CREATE INDEX decision_text IF NOT EXISTS FOR (x:Decision) ON (x.text)',
    'CREATE INDEX decision_version_doc IF NOT EXISTS FOR (v:DecisionVersion) ON (v.docId)',
  ];
  for (const stmt of statements) {
    try {
      await withSession((s) => s.run(stmt));
    } catch (err) {
      // Index creation is an optimisation; ignore failures on restricted users.
      console.warn(`[neo4j] index setup skipped: ${err.message}`);
    }
  }
  indexesEnsured = true;
}

/**
 * Upsert a Document plus its tags / decision / source.
 *
 * Decision handling is adjacency-style, not an overwrite:
 *
 *   (:Document)-[:MADE_DECISION]->(:Decision {text})          current decision
 *   (:Document)-[:HAS_DECISION_VERSION]->(:DecisionVersion)-[:PREVIOUS]->(:DecisionVersion)
 *   (:Document)-[:PREVIOUS_IN_THREAD]->(:Document)            earlier item in the same thread
 *
 * `:Decision` stays merged by text so "documents that share this decision"
 * keeps working across items. `:DecisionVersion` is per-document and holds the
 * superseded chain, so the graph can answer "what is the latest decision here
 * and what was it before" instead of only the latest value.
 *
 * @param {object} [opts]
 * @param {Array}  [opts.history]         superseded decisions, OLDEST first
 * @param {string} [opts.previousDocId]   earlier item in the same thread, if any
 */
async function storeDocumentNode(docId, title, source, decision, tags = [], opts = {}) {
  const d = getDriver();
  if (!d) return false;

  const id = String(docId);
  const cleanTags = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
  const cleanDecision = decision && decision !== 'No decision' ? String(decision).trim() : null;
  const cleanHistory = (Array.isArray(opts.history) ? opts.history : [])
    .filter((h) => h && h.text && String(h.text).trim() && String(h.text).trim() !== 'No decision')
    .map((h, i) => ({
      version: i + 1,
      text: String(h.text).trim(),
      summary: h.summary ? String(h.summary) : '',
      decidedAt: h.decidedAt ? String(h.decidedAt) : '',
      fromDocId: h.fromDocId ? String(h.fromDocId) : '',
      fromTitle: h.fromTitle ? String(h.fromTitle) : '',
      isLatest: false,
    }));
  // The current decision is the final link of the chain. When it is the
  // "No decision" sentinel the chain still records what came before, but no
  // version claims to be current.
  if (cleanDecision) {
    cleanHistory.push({
      version: cleanHistory.length + 1,
      text: cleanDecision,
      summary: '',
      decidedAt: '',
      fromDocId: '',
      fromTitle: '',
      isLatest: true,
    });
  }
  const previousDocId = opts.previousDocId ? String(opts.previousDocId) : null;

  try {
    await ensureIndexes();
    await withSession(async (session) => {
      await session.executeWrite((tx) =>
        tx.run(
          `MERGE (d:Document {id: $docId})
           SET d.title = $title,
               d.source = $source,
               d.decision = $decision,
               d.updatedAt = timestamp()`,
          { docId: id, title, source, decision: cleanDecision }
        )
      );

      if (cleanTags.length) {
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $tags AS tagName
             MERGE (t:Tag {name: tagName})
             MERGE (d:Document {id: $docId})
             MERGE (d)-[:HAS_TAG]->(t)`,
            { docId: id, tags: cleanTags }
          )
        );
      }

      // Repoint MADE_DECISION at the CURRENT decision only. The old query
      // MERGEd a fresh relationship on every update and never removed the
      // previous one, so an edited document accumulated one MADE_DECISION per
      // historical value and "documents sharing this decision" matched stale
      // text the organisation had already moved on from.
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:Document {id: $docId})
           OPTIONAL MATCH (d)-[r:MADE_DECISION]->()
           DELETE r
           WITH d
           WHERE $decision IS NOT NULL
           MERGE (x:Decision {text: $decision})
           MERGE (d)-[:MADE_DECISION]->(x)`,
          { docId: id, decision: cleanDecision }
        )
      );

      // Rebuild this document's version chain from the Mongo-side history.
      // Rebuilding (delete + recreate) rather than diffing keeps the write
      // idempotent: a re-sync that produces the same chain converges instead
      // of leaving orphans behind when history entries shift versions.
      if (cleanHistory.length) {
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (d:Document {id: $docId})
             OPTIONAL MATCH (d)-[:HAS_DECISION_VERSION]->(old:DecisionVersion)
             DETACH DELETE old`,
            { docId: id }
          )
        );
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $versions AS v
             MERGE (x:DecisionVersion {docId: $docId, version: v.version})
             SET x.text = v.text,
                 x.summary = v.summary,
                 x.decidedAt = v.decidedAt,
                 x.fromDocId = v.fromDocId,
                 x.fromTitle = v.fromTitle,
                 x.isLatest = v.isLatest
             MERGE (d:Document {id: $docId})
             MERGE (d)-[:HAS_DECISION_VERSION]->(x)`,
            { docId: id, versions: cleanHistory }
          )
        );
        // One statement links the whole chain: every version points at its
        // immediate predecessor, so a traversal from the latest node walks
        // backwards through the full history.
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (a:DecisionVersion {docId: $docId})
             MATCH (b:DecisionVersion {docId: $docId, version: a.version - 1})
             MERGE (a)-[:PREVIOUS]->(b)`,
            { docId: id }
          )
        );
      } else {
        // Decision removed entirely (now "No decision"): the chain goes too,
        // so nothing claims a current decision that no longer exists.
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (d:Document {id: $docId})
             OPTIONAL MATCH (d)-[:HAS_DECISION_VERSION]->(old:DecisionVersion)
             DETACH DELETE old`,
            { docId: id }
          )
        );
      }

      if (source) {
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (s:Source {name: $source})
             MERGE (d:Document {id: $docId})
             MERGE (d)-[:IN_SOURCE]->(s)`,
            { docId: id, source: String(source) }
          )
        );
      }

      // Mail/Slack thread adjacency: this item follows an earlier one.
      if (previousDocId && previousDocId !== id) {
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (d:Document {id: $docId})
             MERGE (p:Document {id: $previousDocId})
             MERGE (d)-[:PREVIOUS_IN_THREAD]->(p)`,
            { docId: id, previousDocId }
          )
        );
      }
    });
    return true;
  } catch (err) {
    state.lastError = err.message;
    console.warn(`[neo4j] store failed for ${id}: ${err.message}`);
    return false;
  }
}

/**
 * Walk a document's decision chain, newest first.
 *
 * Returns [{ version, text, summary, decidedAt, fromDocId, fromTitle,
 * isLatest }] — the graph-side view of `Document.decisionHistory` plus the
 * current decision as the latest entry.
 */
async function getDecisionHistory(docId) {
  try {
    const records = await withSession((session) =>
      session.executeRead((tx) =>
        tx.run(
          `MATCH (d:Document {id: $docId})-[:HAS_DECISION_VERSION]->(v:DecisionVersion)
           RETURN v.version AS version, v.text AS text, v.summary AS summary,
                  v.decidedAt AS decidedAt, v.fromDocId AS fromDocId,
                  v.fromTitle AS fromTitle, v.isLatest AS isLatest
           ORDER BY v.version DESC`,
          { docId: String(docId) }
        )
      )
    );
    if (!records || !Array.isArray(records.records)) return [];
    return records.records.map((r) => ({
      version: Number(r.get('version')) || 0,
      text: r.get('text'),
      summary: r.get('summary') || '',
      decidedAt: r.get('decidedAt') || '',
      fromDocId: r.get('fromDocId') || '',
      fromTitle: r.get('fromTitle') || '',
      isLatest: Boolean(r.get('isLatest')),
    }));
  } catch (err) {
    state.lastError = err.message;
    return [];
  }
}

/**
 * Documents that share tags with the supplied set — used to widen retrieval
 * context in /api/ask. Excludes any ids already in the primary result set.
 */
/**
 * Clamp a caller-supplied limit into a range the server accepts.
 *
 * The neo4j.int() wrapper is required, not cosmetic. A bare JS number is a
 * double, so the driver encodes 5 as 5.0 and Neo4j 5 rejects a non-integer
 * LIMIT outright ("LIMIT: Invalid input. '5.0' is not a valid value"). Math.trunc
 * alone does not help — the value is still a double when it reaches the wire.
 * Passing it unrounded silently broke both graph read paths, so tag expansion
 * in /api/ask never actually fired.
 */
function clampLimit(limit, { min = 1, max = 25, fallback = 5 } = {}) {
  const n = Number(limit);
  const clamped = Number.isFinite(n) ? Math.trunc(Math.min(Math.max(n, min), max)) : fallback;
  return neo4j.int(clamped);
}

async function getRelatedDocuments(tags, { excludeIds = [], limit = 5 } = {}) {
  const cleanTags = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
  if (!cleanTags.length) return [];

  const excluded = excludeIds.map(String);

  try {
    const records = await withSession((session) =>
      session.executeRead((tx) =>
        tx.run(
          `MATCH (d:Document)-[:HAS_TAG]->(t:Tag)
           WHERE t.name IN $tags AND NOT d.id IN $exclude
           WITH d, count(t) AS shared
           ORDER BY shared DESC, d.updatedAt DESC
           RETURN d.id AS docId, d.title AS title, d.source AS source, shared
           LIMIT $limit`,
          { tags: cleanTags, exclude: excluded, limit: clampLimit(limit) }
        )
      )
    );
    // executeRead resolves to a Result wrapper, not the records array itself.
    if (!records || !Array.isArray(records.records)) return [];

    return records.records.map((r) => ({
      docId: r.get('docId'),
      title: r.get('title'),
      source: r.get('source'),
      sharedTags: Number(r.get('shared')) || 0,
    }));
  } catch (err) {
    state.lastError = err.message;
    console.warn(`[neo4j] related-documents query failed: ${err.message}`);
    return [];
  }
}

/** Neighbour documents through shared decisions (two-hop reasoning). */
async function getDocumentsSharingDecision(decision, { limit = 5 } = {}) {
  if (!decision || decision === 'No decision') return [];
  try {
    const records = await withSession((session) =>
      session.executeRead((tx) =>
        tx.run(
          `MATCH (a:Document)-[:MADE_DECISION]->(x:Decision)<-[:MADE_DECISION]-(b:Document)
           WHERE x.text = $decision AND a.id <> b.id
           RETURN DISTINCT b.id AS docId, b.title AS title, b.source AS source
           LIMIT $limit`,
          { decision: String(decision), limit: clampLimit(limit) }
        )
      )
    );
    // executeRead resolves to a Result wrapper, not the records array itself.
    if (!records || !Array.isArray(records.records)) return [];

    return records.records.map((r) => ({
      docId: r.get('docId'),
      title: r.get('title'),
      source: r.get('source'),
    }));
  } catch (err) {
    state.lastError = err.message;
    return [];
  }
}

/**
 * Remove a document's graph footprint.
 *
 * The Document node and its relationships go. Shared Tag / Decision / Source
 * nodes are only deleted once nothing references them, otherwise deleting one
 * document would dismantle the neighbourhood every other document relies on.
 */
async function deleteDocumentNode(docId) {
  const d = getDriver();
  if (!d) return false;

  const id = String(docId);
  try {
    // Collect only satellites attached to this document before detaching it.
    // A global orphan sweep could delete unrelated pre-existing graph nodes
    // (including ones left by another migration or an interrupted write).
    await withSession((session) =>
      session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:Document {id: $docId})
           OPTIONAL MATCH (d)-[:HAS_TAG]->(tag:Tag)
           WITH d, collect(DISTINCT tag) AS tags
           OPTIONAL MATCH (d)-[:MADE_DECISION]->(decision:Decision)
           WITH d, tags, collect(DISTINCT decision) AS decisions
           OPTIONAL MATCH (d)-[:IN_SOURCE]->(source:Source)
           WITH d, tags, decisions, collect(DISTINCT source) AS sources
           DETACH DELETE d
           WITH tags + decisions + sources AS satellites
           UNWIND satellites AS satellite
           WITH DISTINCT satellite
           WHERE satellite IS NOT NULL AND NOT (satellite)--()
           DELETE satellite`,
          { docId: id }
        )
      )
    );

    // Decision versions are per-document, never shared, so they go by docId.
    // They must be removed separately: DETACH DELETE above clears the document
    // but leaves the version chain linked to itself through PREVIOUS, and the
    // shared-satellite sweep above deliberately refuses to delete any node that
    // still has a relationship.
    await withSession((session) =>
      session.executeWrite((tx) =>
        tx.run(`MATCH (v:DecisionVersion {docId: $docId}) DETACH DELETE v`, { docId: id })
      )
    );
    return true;
  } catch (err) {
    state.lastError = err.message;
    console.warn(`[neo4j] delete failed for ${id}: ${err.message}`);
    return false;
  }
}

async function countNodes() {
  try {
    const records = await withSession((s) =>
      s.executeRead((tx) => tx.run('MATCH (n) RETURN count(n) AS c'))
    );
    return records ? Number(records.records[0]?.get('c')) || 0 : null;
  } catch {
    return null;
  }
}

function status() {
  return {
    configured: isConfigured(),
    disabled,
    lastError: state.lastError,
    lastOkAt: state.lastOkAt,
  };
}

async function close() {
  if (driver) {
    try { await driver.close(); } catch { /* shutting down anyway */ }
    driver = null;
    indexesEnsured = false;
  }
}

module.exports = {
  storeDocumentNode,
  deleteDocumentNode,
  getRelatedDocuments,
  getDocumentsSharingDecision,
  getDecisionHistory,
  countNodes,
  status,
  close,
};
