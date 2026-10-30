require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const authRoutes = require('./routes/auth');
const { requireAuth } = require('./routes/auth');
const ingestRoutes = require('./routes/ingest');
const askRoutes = require('./routes/ask');
const documentsRoutes = require('./routes/documents');
const slackRoutes = require('./routes/slack');
const gmailRoutes = require('./routes/gmail');
const gdocsRoutes = require('./routes/gdocs');

const aiService = require('./services/aiService');
const chromaService = require('./services/chromaService');
const neo4jService = require('./services/neo4jService');
const googleAuth = require('./services/googleAuth');
const scheduler = require('./services/scheduler');
const slackSync = require('./routes/slack');
const gmailSync = require('./routes/gmail');
const gdocsSync = require('./routes/gdocs');

const PORT = Number(process.env.PORT || 5000);
const BODY_LIMIT = process.env.BODY_LIMIT || '1mb';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

app.disable('x-powered-by');

/* ── Middleware ──────────────────────────────────────────── */
app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/non-browser callers (curl, health probes).
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  })
);

// The old default was 100kb, which rejected large pastes with an opaque 413.
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (req.path === '/api/health' || req.path === '/health') return;
    const ms = Date.now() - startedAt;
    // Log the path only. Query strings may carry one-time OAuth codes or other
    // user-provided data and must not be copied into persistent process logs.
    const line = `${req.method} ${req.path} ${res.statusCode} ${ms}ms`;
    if (res.statusCode >= 500) console.error(`[http] ${line}`);
    else if (res.statusCode >= 400) console.warn(`[http] ${line}`);
    else console.log(`[http] ${line}`);
  });
  next();
});

/* ── Routes ──────────────────────────────────────────────── */
app.use('/api/auth', authRoutes);
app.use('/api/ingest', ingestRoutes);
app.use('/api/ask', askRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/slack', slackRoutes);
app.use('/api/gdocs', gdocsRoutes);
// Gmail keeps the OAuth entry points at the root, and the API under /api/gmail.
app.use('/', gmailRoutes);

/* ── Health ──────────────────────────────────────────────── */
// Public: liveness only. No secrets, no filesystem paths, no token state —
// this route is unauthenticated, so anything it returns is disclosed to anyone
// who can reach the port.
app.get(['/health', '/api/health'], async (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;
  res.json({
    status: mongoConnected ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    mongodb: { state: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' },
  });
});

// Authenticated: the full picture, for an operator who has a token.
app.get('/api/health/detail', requireAuth, async (req, res) => {
  const Document = require('./models/Document');

  const [mongoState, indexedDocuments, chromaHealth] = await Promise.all([
    mongoose.connection.readyState === 1
      ? Promise.resolve('connected')
      : Promise.resolve(['disconnected', 'connecting', 'disconnecting', 'disconnected'][mongoose.connection.readyState] ?? 'unknown'),
    Document.estimatedDocumentCount().catch(() => null),
    // ping() dials the server; status() alone reports "not reachable" on a cold
    // start simply because nothing has connected yet.
    chromaService.ping().catch((err) => ({ ...chromaService.status(), reachable: false, lastError: err.message })),
  ]);

  const google = googleAuth.status();

  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    mongodb: { state: mongoState, documents: indexedDocuments },
    ai: aiService.describe(),
    chroma: chromaHealth,
    neo4j: neo4jService.status(),
    google: {
      configured: google.configured,
      connected: google.connected,
      driveFolderConfigured: google.driveFolderConfigured,
      hasRefreshToken: google.hasRefreshToken,
      expiresAt: google.expiresAt,
    },
    slack: { configured: slackSync.isConfigured() },
    scheduler: scheduler.getHealth(),
  });
});

/* ── Index ───────────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({
    service: 'Trace.AI API',
    version: '2.0.0',
    ai: aiService.describe().model,
    routes: {
      auth: ['POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me', 'GET /api/auth/config'],
      data: ['POST /api/ingest', 'POST /api/ask', 'GET /api/documents', 'GET /api/documents/stats', 'GET /api/documents/:id', 'DELETE /api/documents/:id'],
      slack: ['GET /api/slack/channels', 'POST /api/slack/fetch', 'GET /api/slack/health'],
      google: ['GET /auth/google', 'GET /auth/google/callback', 'GET /api/gmail/status', 'POST /api/gmail/fetch', 'GET /api/gdocs/list', 'GET /api/gdocs/status', 'POST /api/gdocs/fetch'],
      system: ['GET /health', 'GET /api/health/detail (bearer token)'],
    },
    note: 'All /api routes except /api/auth and the public health probe require an "Authorization: Bearer <token>" header.',
  });
});

/* ── 404 ─────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

/* ── Central error handler ───────────────────────────────── */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Body parser rejections arrive with a status; surface them usefully.
  const status = err.status || err.statusCode;
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `Request body exceeds the ${BODY_LIMIT} limit` });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  if (status === 403 || /not allowed by CORS/i.test(err.message || '')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const isClient = status >= 400 && status < 500;
  console.error('[error]', err.stack || err.message || err);

  res.status(isClient ? status : 500).json({
    error: isClient ? err.message : 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && !isClient ? { detail: err.message } : {}),
  });
});

/* ── Database ────────────────────────────────────────────── */
async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set. Add it to .env.');
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 20,
  });

  // Build declared indexes (the text index powers keyword search fallback).
  try {
    await mongoose.connection.syncIndexes();
    console.log('[mongo] indexes synchronised');
  } catch (err) {
    console.warn(`[mongo] index sync skipped: ${err.message}`);
  }

  return mongoose.connection.name;
}

/* ── Background polling ──────────────────────────────────── */
function registerSources() {
  scheduler.addSource(
    'gmail',
    () => gmailSync.syncInbox({ maxResults: 10 }),
    { isAvailable: () => googleAuth.isConnected() }
  );

  scheduler.addSource(
    'slack',
    () => slackSync.syncAllChannels({ limit: 5 }),
    { isAvailable: () => slackSync.isConfigured() }
  );

  scheduler.addSource('google_docs', () => gdocsSync.syncFolder(), {
    isAvailable: () => googleAuth.isConnected() && Boolean(googleAuth.getDriveFolderId()),
  });
}

/* ── Boot ────────────────────────────────────────────────── */
(async () => {
  try {
    await connectMongo();
    console.log('[mongo] connected');
  } catch (err) {
    console.error(`[fatal] ${err.message}`);
    console.error('        The API will not start without a working MongoDB connection.');
    process.exit(1);
  }

  if (!aiService.isConfigured()) {
    console.warn('[warn] GEMINI_API_KEY is not set — /api/ingest and /api/ask will return 503.');
  }

  registerSources();
  scheduler.start();

  const server = app.listen(PORT, () => {
    console.log(`\n  Trace.AI API  →  http://localhost:${PORT}`);
    console.log(`  AI            →  ${aiService.describe().model} (${aiService.describe().embedModel})`);
    console.log(`  Health        →  http://localhost:${PORT}/health\n`);
  });

  const shutdown = async (signal) => {
    console.log(`\n[shutdown] ${signal} received, closing gracefully...`);
    scheduler.stop();
    server.close();
    await neo4jService.close().catch(() => {});
    await mongoose.connection.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
})();

module.exports = app;
