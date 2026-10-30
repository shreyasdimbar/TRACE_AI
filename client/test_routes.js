/**
 * test_routes.js — tests for the client route table and auth policy.
 *
 *   npm run test:routes
 *
 * routes.js is deliberately React-free so this can run in plain Node with no
 * DOM, no bundler and no dependencies. The resolveRoute() function is where a
 * "just change the URL" bypass would live, which makes it worth pinning down.
 *
 * Offline: no server, no database, no network.
 */

import assert from 'assert';
import { createRequire } from 'module';
import {
  PUBLIC_ROUTES,
  PROTECTED_ROUTES,
  ALL_ROUTES,
  DEFAULT_AUTHED_ROUTE,
  normalisePath,
  isProtectedRoute,
  isKnownRoute,
  resolveRoute,
  consumeIntended,
} from './src/routes.js';

// consumeIntended is imported above; the require below is only for the
// ESM/CJS interop case where the named import is unavailable.
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

/** Minimal window/sessionStorage stand-in for the pure policy functions. */
function withStorage(initial = {}) {
  const store = { ...initial };
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  return store;
}

/* ── Route table ────────────────────────────────────────── */

test('public routes are exactly landing and login', () => {
  assert.deepStrictEqual(PUBLIC_ROUTES, ['/', '/login']);
});

test('every workspace route is marked protected', () => {
  for (const path of ['/dashboard', '/ask', '/documents', '/ingest', '/settings']) {
    assert.ok(isProtectedRoute(path), `${path} should be protected`);
    assert.ok(!PUBLIC_ROUTES.includes(path), `${path} must not also be public`);
  }
});

test('route table has no duplicates', () => {
  assert.strictEqual(new Set(ALL_ROUTES).size, ALL_ROUTES.length);
});

test('landing and login are not protected', () => {
  assert.ok(!isProtectedRoute('/'));
  assert.ok(!isProtectedRoute('/login'));
});

test('unknown paths are not known routes', () => {
  for (const path of ['/admin', '/../etc/passwd', '/dashboard/../settings', '/api']) {
    assert.ok(!isKnownRoute(path), `${path} should not be a known route`);
  }
});

test('default authed route is a protected route', () => {
  assert.ok(isProtectedRoute(DEFAULT_AUTHED_ROUTE));
});

/* ── Path normalisation ─────────────────────────────────── */

test('trailing slashes normalise to the canonical route', () => {
  assert.strictEqual(normalisePath('/ask/'), '/ask');
  assert.strictEqual(normalisePath('/settings/'), '/settings');
});

test('root keeps its single slash', () => {
  assert.strictEqual(normalisePath('/'), '/');
});

test('index.html normalises to root', () => {
  assert.strictEqual(normalisePath('/index.html'), '/');
});

/* ── The guard ──────────────────────────────────────────── */

test('anonymous visitor asking for a protected path is sent to login', () => {
  withStorage();
  for (const path of PROTECTED_ROUTES) {
    const decision = resolveRoute(path, 'anonymous');
    assert.strictEqual(decision.renderPath, '/login', `${path} leaked to an anonymous visitor`);
    assert.strictEqual(decision.shouldRedirect, true, `${path} did not trigger a redirect`);
  }
});

test('anonymous visitor asking for /settings specifically is refused', () => {
  withStorage();
  const decision = resolveRoute('/settings', 'anonymous');
  assert.notStrictEqual(decision.renderPath, '/settings');
  assert.strictEqual(decision.renderPath, '/login');
});

test('authenticated visitor gets the protected path they asked for', () => {
  withStorage();
  for (const path of PROTECTED_ROUTES) {
    const decision = resolveRoute(path, 'authenticated');
    assert.strictEqual(decision.renderPath, path, `${path} should render when signed in`);
    assert.strictEqual(decision.shouldRedirect, false);
  }
});

test('nothing renders while the session is still being verified', () => {
  withStorage();
  for (const path of ALL_ROUTES) {
    const decision = resolveRoute(path, 'loading');
    assert.strictEqual(decision.renderPath, null, `${path} rendered during the loading flash`);
    assert.strictEqual(decision.shouldRedirect, false);
  }
});

test('public routes stay reachable while anonymous', () => {
  withStorage();
  for (const path of PUBLIC_ROUTES) {
    const decision = resolveRoute(path, 'anonymous');
    assert.strictEqual(decision.renderPath, path);
    assert.strictEqual(decision.shouldRedirect, false);
  }
});

test('unknown path falls back to landing rather than dead-ending', () => {
  withStorage();
  for (const status of ['anonymous', 'authenticated']) {
    const decision = resolveRoute('/admin', status);
    assert.strictEqual(decision.renderPath, '/');
  }
});

test('redirect remembers the protected path so sign-in can restore it', () => {
  const store = withStorage();
  resolveRoute('/settings', 'anonymous');
  assert.strictEqual(
    store.trace_intended,
    '/settings',
    'the blocked destination was not recorded'
  );
});

test('a stored intended destination cannot smuggle in an off-table path', () => {
  // sessionStorage is writable by any script on the page, so consumeIntended()
  // re-validates against the route table. Without that check, an injected
  // value could bounce a user anywhere after sign-in.
  withStorage();
  for (const hostile of ['/admin', '//evil.com', '/api/documents', '/']) {
    const store = withStorage({ trace_intended: hostile });
    const dest = consumeIntended('/dashboard');
    assert.strictEqual(
      dest,
      '/dashboard',
      `hostile stored destination ${hostile} was accepted as ${dest}`
    );
    assert.ok(!store.trace_intended, 'stored value should be cleared after read');
  }
});

test('public paths are not recorded as intended destinations', () => {
  const store = withStorage();
  resolveRoute('/login', 'anonymous');
  assert.strictEqual(Object.keys(store).length, 0, 'a public route was stored as intent');
});

test('missing session status is treated as unauthenticated, not trusted', () => {
  withStorage();
  // Fail closed: an undefined status must not be read as authenticated.
  assert.strictEqual(resolveRoute('/dashboard', undefined).renderPath, '/login');
  assert.strictEqual(resolveRoute('/dashboard', null).renderPath, '/login');
  assert.strictEqual(resolveRoute('/dashboard', 'authenticated').renderPath, '/dashboard');
});

test('a status of "true" or any other junk does not grant access', () => {
  withStorage();
  for (const bogus of [true, 1, 'admin', 'AUTHENTICATED', 'auth']) {
    assert.strictEqual(
      resolveRoute('/dashboard', bogus).renderPath,
      '/login',
      `bogus status ${JSON.stringify(bogus)} was treated as authenticated`
    );
  }
});

/* ── Bypass attempts ──────────────────────────────────────
   Every one of these is a way someone might try to reach a protected page by
   editing the URL. The assertion is deliberately blunt: NOTHING may cause a
   protected path to render for an anonymous visitor. Landing on the public
   landing page is an acceptable outcome for an unrecognised path; rendering
   /settings is not.
   --------------------------------------------------------------------- */

const ATTACK_PATHS = [
  '/settings',
  '/Settings',            // case
  '/SETTINGS',
  '/settings/',           // trailing slash
  '//settings',           // duplicate slash
  '///settings',
  '/settings?tab=x',      // query
  '/settings#anchor',     // fragment
  '/%73ettings',          // percent-encoded 's'
  '/%2Fsettings',
  '/sEtTiNgS/',
  '/settings//',
  '/ask',
  '/ask/',
  '/documents',
  '/documents?source=gmail',
  '/ingest',
  '/dashboard',
  '/index.html/settings',
];

test('no URL variation lets an anonymous visitor render a protected page', () => {
  withStorage();
  const protectedSet = new Set(PROTECTED_ROUTES);
  const leaks = [];
  for (const p of ATTACK_PATHS) {
    const { renderPath } = resolveRoute(p, 'anonymous');
    if (protectedSet.has(renderPath)) leaks.push(`${p} -> ${renderPath}`);
  }
  assert.deepStrictEqual(leaks, [], `URL bypass: ${leaks.join(', ')}`);
});

test('every spelling of a protected route is guarded, not just the canonical one', () => {
  withStorage();
  for (const p of ['/settings', '/Settings', '/settings/', '//settings', '/%73ettings', '/settings?tab=x']) {
    assert.strictEqual(
      resolveRoute(p, 'anonymous').renderPath,
      '/login',
      `${p} should redirect to login while signed out`
    );
  }
});

test('a signed-in user is not blocked by a trailing slash or odd casing', () => {
  withStorage();
  for (const p of ['/settings', '/Settings', '/settings/', '//settings', '/DOCUMENTS', '/ask?x=1']) {
    const expected = normalisePath(p);
    assert.strictEqual(
      resolveRoute(p, 'authenticated').renderPath,
      expected,
      `${p} should render as ${expected} when signed in`
    );
  }
});

test('normalisePath folds case, slashes, encoding, query and fragment', () => {
  assert.strictEqual(normalisePath('/Settings'), '/settings');
  assert.strictEqual(normalisePath('//ask'), '/ask');
  assert.strictEqual(normalisePath('/ask/'), '/ask');
  assert.strictEqual(normalisePath('/%73ettings'), '/settings');
  assert.strictEqual(normalisePath('/ask?x=1'), '/ask');
  assert.strictEqual(normalisePath('/ask#top'), '/ask');
  assert.strictEqual(normalisePath('/index.html'), '/');
  // Malformed input must not throw.
  assert.strictEqual(normalisePath('/%'), '/%');
  assert.strictEqual(normalisePath(''), '/');
  assert.strictEqual(normalisePath(undefined), '/');
});

test('an unknown path never renders anything protected, signed in or not', () => {
  withStorage();
  const protectedSet = new Set(PROTECTED_ROUTES);
  for (const p of ['/admin', '/api/documents', '/../admin', '/config', '/users']) {
    for (const status of ['anonymous', 'authenticated']) {
      const { renderPath } = resolveRoute(p, status);
      assert.ok(
        !protectedSet.has(renderPath),
        `${p} rendered protected page ${renderPath} for ${status}`
      );
    }
  }
});

/* ── Runner ─────────────────────────────────────────────── */

async function run() {
  console.log('');
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
    }
  }
  console.log(`\n${failed ? 'FAILED' : 'OK'}  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

run();