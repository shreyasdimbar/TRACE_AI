/**
 * routes.js — route table and the auth policy for it.
 *
 * Deliberately free of React so the security rule can be tested directly.
 * router.jsx does the React binding on top of this; the interesting decision -
 * "may this visitor see this path?" - is the pure function resolveRoute() here,
 * which is where a bypass would live if one existed.
 *
 * THE SECURITY PROPERTY THIS FILE EXISTS TO PROVIDE
 * -------------------------------------------------------
 * resolveRoute() refuses to hand a protected path to anyone who is not
 * authenticated. It never returns a workspace path while the session status is
 * 'loading' or 'anonymous'; it returns /login and records where the user was
 * headed so sign-in can return them there.
 *
 * This is a UX guard, NOT a security boundary, and it is worth being precise
 * about that. Everything here runs in the browser, so anyone determined can
 * defeat it by editing state in a devtools console. The real protection is
 * server-side: every data route in routes/ rejects requests without a valid
 * bearer token, so bypassing this file yields empty pages with no data behind
 * them. This exists so that reaching /settings by URL is not something a user
 * stumbles into accidentally - not so that data can be kept secret by the client.
 */

/** Public routes a signed-out visitor may reach. */
export const PUBLIC_ROUTES = ['/', '/login'];

/** Routes that require a verified session. */
export const PROTECTED_ROUTES = ['/dashboard', '/ask', '/documents', '/ingest', '/settings'];

export const ALL_ROUTES = [...PUBLIC_ROUTES, ...PROTECTED_ROUTES];

/** Where a user lands after signing in, absent a remembered destination. */
export const DEFAULT_AUTHED_ROUTE = '/dashboard';

const INTENDED_KEY = 'trace_intended';

/**
 * Normalise a pathname into its canonical form.
 *
 * Three things are folded away, all of which would otherwise be a route the
 * table does not recognise:
 *   - a trailing slash, so /ask/ and /ask are the same page
 *   - letter case, so /Settings is not treated as an unknown path
 *   - the index.html a static host may serve, so it maps to /
 *
 * Query strings and fragments are stripped: `location.pathname` never contains
 * them, but `navigate()` can be handed a full href, and a path that carried
 * "?tab=x" would fail the membership test and dump the user on the landing page.
 */
export function normalisePath(pathname) {
  if (typeof pathname !== 'string' || pathname === '') return '/';

  // Drop ?query and #fragment if present.
  let path = pathname.split('?')[0].split('#')[0];

  // Decode percent-escapes so "/%73ettings" resolves to /settings rather than
  // being rejected as unknown. decodeURIComponent throws on malformed input
  // such as a bare "%", so fall back to the raw string rather than throwing.
  try {
    path = decodeURIComponent(path);
  } catch {
    // Leave the raw value; it will simply fail the membership test.
  }

  // Collapse duplicate slashes and strip a trailing one.
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  if (path === '/index.html' || path === '') return '/';

  return path.toLowerCase();
}

export function currentPath() {
  return normalisePath(
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );
}

/** True when `path` is a workspace route that needs a session. */
export function isProtectedRoute(path) {
  return PROTECTED_ROUTES.includes(path);
}

/** True when `path` is a route this app knows about. */
export function isKnownRoute(path) {
  return ALL_ROUTES.includes(path);
}

/**
 * The auth decision, as a pure function.
 *
 * Returns the path that should actually be rendered:
 *   - null            while the session is still being verified, so the caller
 *                     shows a boot screen instead of flashing the login page
 *   - /login          for any protected path requested without a session
 *   - the path itself when it is public, or protected and authenticated
 *   - /               for an unknown path (a dead end is worse than a fallback)
 *
 * `shouldRedirect` distinguishes "you may see this" from "we sent you
 * somewhere else", so the caller can decide whether to push a history entry.
 */
export function resolveRoute(rawPath, status) {
  // Normalise BEFORE the membership test. Without this, "/settings/" fails
  // isKnownRoute and falls through to the landing page - still safe (the
  // protected page never renders) but wrong: a signed-out visitor typing
  // "/settings/" should be sent to login like any other protected path, not
  // silently shown the marketing page. Case is folded for the same reason.
  const path = normalisePath(rawPath);
  const target = isKnownRoute(path) ? path : '/';

  if (status === 'loading') {
    return { renderPath: null, shouldRedirect: false, path: target };
  }

  if (isProtectedRoute(target) && status !== 'authenticated') {
    // Remember the intent before redirecting, so sign-in can restore it.
    rememberIntended(target);
    return { renderPath: '/login', shouldRedirect: true, path: target };
  }

  return { renderPath: target, shouldRedirect: false, path: target };
}

/** Programmatic navigation. pushState so Back/Forward behave as expected. */
export function navigate(to, { replace = false } = {}) {
  if (typeof window === 'undefined') return;
  const path = to || '/';
  const current = `${window.location.pathname}${window.location.search}`;
  if (path === current) return;

  if (replace) {
    window.history.replaceState({}, '', path);
  } else {
    window.history.pushState({}, '', path);
  }
  // pushState/replaceState emit no event, so announce the change ourselves.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Remember where an unauthenticated visitor was headed.
 *
 * sessionStorage rather than localStorage: this is per-tab navigation intent,
 * not a durable preference, and should not follow the user into a later session.
 */
export function rememberIntended(path) {
  try {
    if (isProtectedRoute(path)) {
      window.sessionStorage.setItem(INTENDED_KEY, path);
    }
  } catch {
    // Private mode or storage disabled: the redirect still works, the user just
    // lands on the default page. Not worth surfacing an error for.
  }
}

/** Read and clear the remembered destination, ignoring anything unsafe. */
export function consumeIntended(fallback = DEFAULT_AUTHED_ROUTE) {
  try {
    const stored = window.sessionStorage.getItem(INTENDED_KEY);
    window.sessionStorage.removeItem(INTENDED_KEY);
    // Re-validated on read: sessionStorage is attacker-writable in an XSS, so a
    // stored value must never be trusted as a destination without a membership
    // check against the known route table.
    return isProtectedRoute(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}