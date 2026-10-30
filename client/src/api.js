const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5000';

/**
 * Every route except /api/auth and the Google OAuth entry points requires an
 * "Authorization: Bearer <jwt>" header. The token is written to localStorage by
 * the login flow, so read it per-request rather than caching it at module load.
 */
function authHeaders(extra = {}) {
  const token = localStorage.getItem('trace_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * Called when an authenticated request comes back 401 - the token expired or was
 * revoked elsewhere. session.js registers the real handler.
 *
 * This is a registration hook rather than an import of session.js on purpose:
 * session.js imports this module, so importing it back would be a circular
 * dependency, and a dynamic import would only paper over the cycle while
 * costing a chunking warning at build time. One-way registration keeps the
 * dependency graph acyclic.
 */
let onUnauthorized = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/** Surface the server's error message instead of a generic failure. */
async function request(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: auth ? authHeaders() : { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    // A 401 on an authenticated call means the token expired or was revoked
    // (e.g. signed out in another tab). Tear the session down so the route guard
    // redirects to login, instead of leaving a shell that fails every request.
    if (res.status === 401 && auth && onUnauthorized) {
      try {
        onUnauthorized();
      } catch {
        // Never let error handling mask the original 401.
      }
    }
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

export const api = {
  request,

  // ── Auth ────────────────────────────────────────────────
  login: async (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  register: async (name, email, password) =>
    request('/api/auth/register', { method: 'POST', body: { name, email, password }, auth: false }),
  me: async () => request('/api/auth/me'),
  /**
   * Server-side sign-out. Retires every token ever issued to this account, so a
   * token copied out of localStorage stops working immediately rather than
   * remaining valid until its expiry.
   */
  logout: async () => request('/api/auth/logout', { method: 'POST', body: {} }),

  // ── Query ───────────────────────────────────────────────
  ask: async (question) => request('/api/ask', { method: 'POST', body: { question } }),

  // ── Documents ───────────────────────────────────────────
  /**
   * @param source          filter by source, '' for all
   * @param limit           page size (server caps at 100)
   * @param includeContent  pass false for a lean list without rawContent
   * @param skip            offset for paging; the server returns hasMore + total
   */
  getDocuments: async (source = '', limit = 50, includeContent = true, skip = 0) => {
    const params = new URLSearchParams();
    if (source) params.set('source', source);
    params.set('limit', String(limit));
    if (!includeContent) params.set('includeContent', 'false');
    if (skip > 0) params.set('skip', String(skip));
    return request(`/api/documents?${params}`);
  },

  getDocument: async (id) => request(`/api/documents/${id}`),
  deleteDocument: async (id) => request(`/api/documents/${id}`, { method: 'DELETE' }),
  getDocumentStats: async () => request('/api/documents/stats'),

  // ── Ingest ──────────────────────────────────────────────
  ingest: async (source, title, content, metadata = {}) =>
    request('/api/ingest', { method: 'POST', body: { source, title, content, metadata } }),

  // ── Slack ───────────────────────────────────────────────
  getSlackChannels: async () => request('/api/slack/channels'),
  fetchSlack: async (channelName, limit = 10) =>
    request('/api/slack/fetch', { method: 'POST', body: { channel_name: channelName, limit } }),

  // ── Gmail ───────────────────────────────────────────────
  // The server accepts both `count` and `max_results`; send the canonical name.
  fetchGmail: async (maxResults = 10) =>
    request('/api/gmail/fetch', { method: 'POST', body: { max_results: maxResults } }),
  getGmailStatus: async () => request('/api/gmail/status'),
  getGmailAuthUrl: () => `${API_BASE}/auth/google`,

  // ── Google Docs ─────────────────────────────────────────
  listDriveDocs: async () => request('/api/gdocs/list'),
  fetchDriveDocs: async () => request('/api/gdocs/fetch', { method: 'POST' }),
  getGDocsStatus: async () => request('/api/gdocs/status'),

  // ── System ──────────────────────────────────────────────
  health: async () => request('/health', { auth: false }),
};
