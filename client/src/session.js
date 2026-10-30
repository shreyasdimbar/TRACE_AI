/**
 * session.js — single source of truth for "who is signed in".
 *
 * The token lives in localStorage (see api.js) and the session object mirrors
 * it. Everything that needs to know whether the visitor is authenticated reads
 * this module rather than poking at localStorage directly, so there is one
 * place that decides what "signed in" means.
 *
 * The three states are deliberately distinct:
 *   loading        - a saved token exists but has not been verified yet. Render
 *                    the boot screen; do NOT redirect, or a refresh flashes the
 *                    login page at someone who is genuinely signed in.
 *   authenticated  - /api/auth/me returned a user for this token.
 *   anonymous      - no token, or the server rejected it.
 *
 * Sign-out is enforced server-side (routes/auth.js bumps tokenVersion, which
 * retires every token ever issued to the account), not merely by clearing
 * localStorage. A token lifted from storage by an XSS payload stops working the
 * moment the user signs out, rather than remaining valid for the full TTL.
 */

import { api, setUnauthorizedHandler } from './api';
import { clearMessages } from './chatStore';

const TOKEN_KEY = 'trace_token';
const USER_KEY = 'trace_user';

/** Notified on every transition, so React components can re-render. */
const listeners = new Set();

let state = {
  status: 'loading',
  user: null,
  token: null,
};

/** Fan a state change out to subscribers. */
function emit() {
  for (const fn of listeners) fn(state);
}

/** Read what is in storage without touching the network. */
function fromStorage() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    return { token, cachedUser: rawUser ? JSON.parse(rawUser) : null };
  } catch {
    // Corrupt JSON or storage disabled - treat as signed out rather than
    // letting a parse error take down the whole app.
    return { token: null, cachedUser: null };
  }
}

function setState(next) {
  state = { ...state, ...next };
  emit();
  return state;
}

/** Subscribe to session changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/** Current session snapshot. */
export function getSession() {
  return state;
}

/**
 * Verify any stored token against the server and settle the session.
 *
 * Called once on boot. An expired or revoked token is cleared here rather than
 * left to fail the first data request, so the user gets one clean redirect to
 * login instead of a burst of 401s.
 */
export async function bootstrap() {
  const { token, cachedUser } = fromStorage();

  if (!token) {
    return setState({ status: 'anonymous', user: null, token: null });
  }

  // Optimistically authenticated from cache so the boot screen is brief, but
  // still verify - a token can be expired or revoked since it was written.
  setState({ status: 'loading', user: cachedUser, token });

  try {
    const data = await api.me();
    return setState({ status: 'authenticated', user: data.user, token });
  } catch {
    clearStoredSession();
    return setState({ status: 'anonymous', user: null, token: null });
  }
}

/** Record a successful sign-in. */
export function adoptSession(user, token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // Storage unavailable: the in-memory session still works for this tab.
  }
  return setState({ status: 'authenticated', user, token });
}

function clearStoredSession() {
  // The chat transcript is scoped to the session, so it goes where the session
  // goes. Hooking it here rather than inside signOut() alone means every path
  // that ends a session clears it too — a token revoked elsewhere and a failed
  // bootstrap included. The id is read before the caller resets state.
  clearMessages(state.user?.id);

  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // Nothing to do - the state reset below is what actually matters.
  }
}

/**
 * Sign out.
 *
 * Calls the server first so the token is genuinely revoked, then clears local
 * state. The local clear happens even if the request fails, because leaving a
 * user stuck in a signed-in-looking shell they cannot leave is worse than a
 * token that outlives one failed logout while offline.
 */
export async function signOut({ navigateTo } = {}) {
  const hadToken = Boolean(fromStorage().token);

  if (hadToken) {
    try {
      await api.logout();
    } catch {
      // Offline or server down. Clear locally anyway; the token expires on its
      // own and is already useless without the server.
    }
  }

  clearStoredSession();
  setState({ status: 'anonymous', user: null, token: null });
  if (navigateTo) navigateTo('/');
}

/**
 * Handle a 401 from any data request.
 *
 * The server rejecting a token we believed in means it expired or was revoked
 * somewhere else. Clear the session so the guard redirects to login, instead of
 * leaving the UI showing an authenticated shell that silently fails every call.
 * Returns true when it handled the rejection.
 */
export function handleUnauthorized() {
  if (state.status === 'anonymous') return false;
  clearStoredSession();
  setState({ status: 'anonymous', user: null, token: null });
  return true;
}

// Registered once at module load. api.js calls this when any authenticated
// request returns 401, which is how an expired or revoked token gets the user
// back to the login screen from anywhere in the app.
setUnauthorizedHandler(handleUnauthorized);