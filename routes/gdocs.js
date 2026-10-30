const express = require('express');
const router = express.Router();

const googleAuth = require('../services/googleAuth');
const { ingestDocument } = require('../services/ingestService');
const scheduler = require('../services/scheduler');
const { requireAuth } = require('./auth');
const Document = require('../models/Document');

const DOC_MIME = 'application/vnd.google-apps.document';
const MAX_DOC_CHARS = Number(process.env.GDOCS_MAX_CHARS || 6000);

/* ──────────────────────────────────────────────────────────
   Google Docs → plain text
   ────────────────────────────────────────────────────────── */

/**
 * Flatten a Google Docs body into plain text.
 *
 * Walks structural elements rather than only top-level paragraphs, so content
 * inside tables, list items and nested tables is captured. The previous version
 * only read `body.content[].paragraph`, which silently dropped every table.
 */
function extractTextFromDoc(docData) {
  const content = docData?.body?.content || [];
  const parts = [];

  const readParagraph = (paragraph) => {
    let text = '';
    for (const el of paragraph?.elements || []) {
      if (el.textRun?.content) text += el.textRun.content;
    }
    return text;
  };

  const readTable = (table) => {
    const rows = [];
    for (const row of table?.tableRows || []) {
      const cells = [];
      for (const cell of row?.tableCells || []) {
        const cellParts = [];
        for (const block of cell?.content || []) {
          if (block.paragraph) cellParts.push(readParagraph(block.paragraph));
          if (block.table) cellParts.push(readTable(block.table));
        }
        cells.push(cellParts.join(' ').trim());
      }
      rows.push(cells.filter(Boolean).join(' | '));
    }
    return rows.filter(Boolean).join('\n');
  };

  for (const element of content) {
    if (element.paragraph) {
      const text = readParagraph(element.paragraph).trim();
      if (text) parts.push(text);
    } else if (element.table) {
      const table = readTable(element.table);
      if (table) parts.push(table);
    }
  }

  return parts.join('\n\n').trim();
}

/* ──────────────────────────────────────────────────────────
   Drive helpers
   ────────────────────────────────────────────────────────── */

function folderQuery(folderId) {
  return `'${folderId}' in parents and mimeType='${DOC_MIME}' and trashed=false`;
}

async function listDocs(drive, folderId) {
  const response = await drive.files.list({
    q: folderQuery(folderId),
    fields: 'files(id, name, createdTime, modifiedTime, owners, webViewLink)',
    pageSize: 100,
    orderBy: 'modifiedTime desc',
  });
  return response.data.files || [];
}

/**
 * Preview the folder and mark which docs are already indexed.
 * Reports `stale` when the stored version predates the Drive version.
 */
async function previewFolder() {
  const drive = googleAuth.api('drive');
  const folderId = googleAuth.getDriveFolderId();

  if (!drive) return { code: 'NOT_CONNECTED' };
  if (!folderId) return { code: 'NO_FOLDER' };

  const files = await listDocs(drive, folderId);
  const ids = files.map((f) => f.id);

  const stored = ids.length
    ? await Document.find({ 'metadata.googleDocId': { $in: ids } })
        .select('metadata.googleDocId metadata.modifiedTime')
        .lean()
    : [];

  const storedById = new Map(stored.map((d) => [d.metadata?.googleDocId, d.metadata?.modifiedTime]));

  return {
    folderId,
    files: files.map((f) => {
      const seen = storedById.get(f.id);
      return {
        id: f.id,
        name: f.name,
        createdTime: f.createdTime,
        modifiedTime: f.modifiedTime,
        owner: f.owners?.[0]?.displayName || 'Unknown',
        link: f.webViewLink,
        alreadyIngested: Boolean(seen),
        stale: Boolean(seen) && seen !== f.modifiedTime,
      };
    }),
  };
}

/**
 * Sync every doc in the folder.
 *
 * The old dedup key was {googleDocId, modifiedTime}, so every single edit
 * created a brand new Document — the feed filled with near-duplicates and each
 * one left its own vector behind. We now match on googleDocId alone and update
 * in place, which keeps the Mongo id (and therefore the Chroma id) stable.
 */
async function syncFolder() {
  const drive = googleAuth.api('drive');
  const docs = googleAuth.api('docs');
  const folderId = googleAuth.getDriveFolderId();

  if (!drive || !docs) return { error: 'Google is not connected. Visit /auth/google first.', code: 'NOT_CONNECTED' };
  if (!folderId) return { error: 'GOOGLE_DRIVE_FOLDER_ID is not set in .env', code: 'NO_FOLDER' };

  try {
    const files = await listDocs(drive, folderId);
    const ingested = [];
    const updated = [];
    const skipped = [];

    // Skip anything whose Drive modifiedTime already matches what we stored.
    //
    // syncFolder used to hand every file to ingestDocument with
    // replaceExisting, and replaceExisting always re-runs extractReasoning —
    // so a folder of ~10 docs cost ~10 Gemini calls on *every* tick, once a
    // minute, for content that had not moved. previewFolder already computed
    // this staleness flag; it was simply never consulted here. The same
    // check is what makes a manual "Sync now" free when nothing changed.
    const ids = files.map((f) => f.id);
    const stored = ids.length
      ? await Document.find({ 'metadata.googleDocId': { $in: ids } })
          .select('metadata.googleDocId metadata.modifiedTime')
          .lean()
      : [];
    const storedById = new Map(stored.map((d) => [d.metadata?.googleDocId, d.metadata?.modifiedTime]));

    for (const file of files) {
      const seenModified = storedById.get(file.id);
      if (seenModified && seenModified === file.modifiedTime) {
        skipped.push({ id: file.id, name: file.name, reason: 'unchanged' });
        continue;
      }

      let text;
      try {
        const docResp = await docs.documents.get({ documentId: file.id });
        text = extractTextFromDoc(docResp.data);
      } catch (err) {
        skipped.push({ id: file.id, name: file.name, reason: err?.message || 'read_failed' });
        continue;
      }

      if (!text) {
        skipped.push({ id: file.id, name: file.name, reason: 'empty_content' });
        continue;
      }

      const result = await ingestDocument({
        source: 'google_docs',
        title: file.name,
        content: text.slice(0, MAX_DOC_CHARS),
        metadata: {
          googleDocId: file.id,
          createdTime: file.createdTime,
          modifiedTime: file.modifiedTime,
          fullLength: text.length,
          link: file.webViewLink,
        },
        dedupQuery: { 'metadata.googleDocId': file.id, source: 'google_docs' },
        replaceExisting: true,
      });

      if (result.replaced) updated.push({ docId: result.docId, name: file.name, modifiedTime: file.modifiedTime });
      else if (!result.duplicate) ingested.push({ docId: result.docId, name: file.name, summary: result.summary });
    }

    return {
      success: true,
      folderId,
      scanned: files.length,
      ingested_count: ingested.length,
      updated_count: updated.length,
      skipped_count: skipped.length,
      ingested,
      updated,
      skipped,
    };
  } catch (err) {
    // See gmail.js: a rejected refresh token is dropped so the source idles.
    if (googleAuth.handleError(err)) {
      return { error: 'Google token was rejected. Re-run /auth/google to reconnect.', code: 'NOT_CONNECTED' };
    }
    const message = err?.errors?.[0]?.message || err.message;
    console.error(`[gdocs] sync failed: ${message}`);
    return { error: message, code: 'GDRIVE_ERROR' };
  }
}

/* ──────────────────────────────────────────────────────────
   Routes
   ────────────────────────────────────────────────────────── */

// ── GET /api/gdocs/list ────────────────────────────────────
router.get('/list', requireAuth, async (req, res, next) => {
  try {
    const result = await previewFolder();

    if (result.code === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'Google not connected. Go to /auth/google to authenticate.' });
    }
    if (result.code === 'NO_FOLDER') {
      return res.status(400).json({ error: 'GOOGLE_DRIVE_FOLDER_ID is not set in .env' });
    }

    res.json({
      success: true,
      folder_id: result.folderId,
      count: result.files.length,
      files: result.files,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/gdocs/status ──────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
  res.json(googleAuth.status());
});

// ── POST /api/gdocs/fetch ──────────────────────────────────
router.post('/fetch', requireAuth, async (req, res) => {
  // Identical to the cron call — zero args, same function — so joining an
  // in-flight tick is indistinguishable from running it here.
  const result = await scheduler.runExclusive('google_docs', () => syncFolder());

  if (result.error) {
    const status =
      result.code === 'NOT_CONNECTED' ? 401 : result.code === 'NO_FOLDER' ? 400 : result.code === 'GDRIVE_ERROR' ? 502 : 500;
    return res.status(status).json(result);
  }
  res.json(result);
});

module.exports = router;
module.exports.syncFolder = syncFolder;
module.exports.extractTextFromDoc = extractTextFromDoc;
