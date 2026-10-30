/**
 * googleAuth — shared Google OAuth2 + token store.
 *
 * gmail.js and gdocs.js both need the same credentials, the same scopes and the
 * same on-disk token cache. Previously each kept its own copy, and neither
 * persisted tokens refreshed by the library, so every restart burned a refresh
 * round-trip and a rotated refresh token could be lost.
 *
 * The `tokens` event is how googleapis surfaces a refreshed credential; we
 * write it straight back to disk.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH
  ? path.resolve(process.env.GMAIL_TOKEN_PATH)
  : path.join(__dirname, '..', 'gmail_tokens.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

let cachedTokens = null;
let cachedClient = null;

function isConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.GMAIL_REDIRECT_URI
  );
}

function readTokensFromDisk() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.refresh_token ? parsed : null;
  } catch (err) {
    console.warn(`[google] could not read token file: ${err.message}`);
    return null;
  }
}

function getTokens() {
  if (!cachedTokens) {
    cachedTokens = readTokensFromDisk();
    if (cachedTokens) console.log('[google] loaded OAuth tokens from disk');
  }
  return cachedTokens;
}

function saveTokens(tokens) {
  cachedTokens = tokens;
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    // The file holds a long-lived refresh token: keep it owner-only.
    fs.chmodSync(TOKEN_PATH, 0o600);
    console.log('[google] tokens saved to disk');
  } catch (err) {
    console.warn(`[google] could not persist tokens: ${err.message}`);
  }
}

function clearTokens() {
  cachedTokens = null;
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  } catch { /* nothing to clean */ }
}

/** A bare client for building the consent URL (no credentials yet). */
function getAuthClient() {
  if (!isConfigured()) {
    const err = new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REDIRECT_URI are not set');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  if (cachedClient) {
    // The cached client may predate consent: getAuthUrl() creates one with no
    // credentials, and the callback's getToken() does not necessarily leave them
    // on that instance. Returning it blindly produced
    // "No access, refresh token, API key or refresh handler callback is set" on
    // the very first sync after authorising. Re-apply the stored tokens whenever
    // the cached client has none.
    const creds = cachedClient.credentials || {};
    if (!creds.access_token && !creds.refresh_token && !creds.api_key) {
      const current = getTokens();
      if (current) cachedClient.setCredentials(current);
    }
    return cachedClient;
  }

  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );

  // Persist any refresh so the on-disk file never goes stale.
  client.on('tokens', (tokens) => {
    saveTokens({ ...getTokens(), ...tokens });
  });

  const existing = getTokens();
  if (existing) client.setCredentials(existing);

  cachedClient = client;
  return client;
}

/** An authenticated client, or null when the user has not consented yet. */
function getAuthenticatedClient() {
  if (!getTokens()) return null;
  const client = getAuthClient();
  const creds = client.credentials || {};
  const expired = creds.expiry_date && creds.expiry_date < Date.now();
  if (expired && !creds.refresh_token) {
    console.warn('[google] access token expired and no refresh token available');
    return null;
  }
  return client;
}

/**
 * Single-use, expiring CSRF tokens for the consent round-trip.
 *
 * Without this the callback accepts any authorization code that lands on it, so
 * an attacker can walk a victim through a flow that binds the attacker's Google
 * account to this server. Each state is consumed on first use — deleted whether
 * or not it matched — so a replayed callback cannot succeed twice.
 */
const STATE_TTL_MS = Number(process.env.GOOGLE_STATE_TTL_MS || 10 * 60 * 1000);
const pendingStates = new Map();

function issueState() {
  const now = Date.now();
  for (const [k, exp] of pendingStates) {
    if (exp <= now) pendingStates.delete(k);
  }
  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

function consumeState(state) {
  if (!state) return false;
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

/**
 * Drop the stored token when Google tells us it is no longer usable.
 *
 * The usual cause is rotating GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET, which
 * invalidates refresh tokens issued to the old client. Left in place the
 * scheduler re-attempts forever and logs invalid_grant on every tick while
 * isConnected() keeps claiming the account is linked.
 */
const FATAL_GRANT_ERRORS = new Set(['invalid_grant', 'invalid_request', 'unauthorized_client', 'access_denied']);

function handleError(err) {
  const message = String(err?.message || err || '');
  const isAuthFailure = FATAL_GRANT_ERRORS.has(message) || /\b(invalid_grant|invalid_client|unauthorized_client)\b/.test(message);
  if (!isAuthFailure) return false;

  console.warn('[google] stored token rejected (' + message + ') — clearing it; re-run /auth/google');
  clearTokens();
  cachedClient = null;
  return true;
}

function isConnected() {
  return Boolean(getTokens());
}

function getAuthUrl() {
  return getAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state: issueState(),
  });
}

/**
 * Trade an authorization code for tokens, but only if it answers a consent
 * request this process actually issued.
 */
async function exchangeCode(code, state) {
  if (!consumeState(state)) {
    const err = new Error(
      'OAuth state mismatch. Start consent from /auth/google in this app; a callback with an unrecognised or reused state is rejected.'
    );
    err.code = 'INVALID_STATE';
    throw err;
  }
  const client = getAuthClient();
  const { tokens } = await client.getToken(code);
  const merged = { ...getTokens(), ...tokens };
  // Apply them to the live client as well as the file, so the first sync after
  // consent does not depend on whether the cached instance was pre-consent.
  client.setCredentials(merged);
  saveTokens(merged);
  return merged;
}

/** Gmail / Drive / Docs API handles, or null when not connected. */
function api(kind) {
  const auth = getAuthenticatedClient();
  if (!auth) return null;
  switch (kind) {
    case 'gmail': return google.gmail({ version: 'v1', auth });
    case 'drive': return google.drive({ version: 'v3', auth });
    case 'docs': return google.docs({ version: 'v1', auth });
    default: throw new Error(`unknown google api: ${kind}`);
  }
}

function getDriveFolderId() {
  return process.env.GOOGLE_DRIVE_FOLDER_ID || null;
}

function status() {
  const tokens = getTokens();
  return {
    configured: isConfigured(),
    connected: Boolean(tokens),
    scopes: tokens?.scope ? String(tokens.scope).split(/\s+/).filter(Boolean) : [],
    expiresAt: tokens?.expiry_date ? new Date(Number(tokens.expiry_date)).toISOString() : null,
    hasRefreshToken: Boolean(tokens?.refresh_token),
    driveFolderConfigured: Boolean(getDriveFolderId()),
    tokenPath: TOKEN_PATH,
  };
}

module.exports = {
  SCOPES,
  isConfigured,
  isConnected,
  getAuthUrl,
  exchangeCode,
  getAuthenticatedClient,
  getDriveFolderId,
  api,
  status,
  clearTokens,
  handleError,
  TOKEN_PATH,
};
