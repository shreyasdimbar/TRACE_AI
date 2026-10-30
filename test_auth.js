/**
 * test_auth.js — integration tests for the authentication boundary.
 *
 *   npm run test:auth
 *
 * These hit a running API over HTTP rather than importing the app, because the
 * thing worth testing is the boundary a real attacker meets: raw requests with
 * no token, a forged token, a stolen-but-revoked token. Calling requireAuth()
 * directly would pass regardless of how the routes were wired.
 *
 * Requires the API and MongoDB to be up: npm run db:start && npm start
 */

require('dotenv').config();

const assert = require('assert');

const BASE = process.env.TEST_API_BASE || 'http://localhost:5000';

/**
 * Register is rate limited to 5/IP per 15 minutes, which is correct behaviour but
 * makes the suite fail on its second run from the same host - it exhausts the
 * shared IP bucket during the first run and every later run gets 429.
 *
 * Rather than raise the limit (which would weaken a real control), the suite
 * reuses one account across runs: register once, and if that returns 409 fall
 * back to logging in with the same credentials. The account is keyed to a
 * stable per-suite email so repeated runs converge on the same user.
 */
const STABLE_EMAIL = process.env.TEST_AUTH_EMAIL || 'auth.suite@walchandsangli.ac.in';
const STABLE_PASSWORD = process.env.TEST_AUTH_PASSWORD || 'Suite@12345';

let passed = 0;
let failed = 0;
let skipped = 0;
const queue = [];

/** Thrown to mark a test as not run, rather than silently passing. */
class Skipped extends Error {}

function skip(reason) {
  throw new Skipped(reason);
}

function test(name, fn) {
  queue.push({ name, fn });
}

/** Unique per-run address for tests that need a genuinely fresh account. */
const stamp = Date.now();

/** The long-lived account the suite reuses across runs. */
const USER = {
  name: 'Auth Suite',
  email: STABLE_EMAIL,
  password: STABLE_PASSWORD,
};

/** A never-reused address, for the duplicate-email test. */
const FRESH_EMAIL = `authfresh${stamp}@walchandsangli.ac.in`;

/** Minimal fetch wrapper returning { status, body }. */
async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, body: data };
}

/** Endpoints that must never answer an anonymous caller. */
const GUARDED = [
  ['GET', '/api/documents'],
  ['GET', '/api/documents/stats'],
  ['GET', '/api/documents/000000000000000000000000'],
  ['DELETE', '/api/documents/000000000000000000000000'],
  ['POST', '/api/ask'],
  ['GET', '/api/slack/channels'],
  ['POST', '/api/slack/fetch'],
  ['GET', '/api/slack/health'],
  ['GET', '/api/gmail/status'],
  ['POST', '/api/gmail/fetch'],
  ['GET', '/api/gdocs/list'],
  ['GET', '/api/gdocs/status'],
  ['POST', '/api/gdocs/fetch'],
  ['POST', '/api/ingest'],
  ['GET', '/api/health/detail'],
  ['GET', '/api/auth/me'],
];

/**
 * Register is rate limited per IP (5 per 15 min by default), and that limit is
 * checked BEFORE any validation. Once the bucket is spent every register call
 * returns 429 and the 400 assertions are unreachable.
 *
 * A 429 means "the control worked", not "validation regressed" - so it is
 * reported as an explicit skip. Silently passing would be worse than failing:
 * it would report coverage that was never actually exercised.
 */
function expectRegisterRejection(status, expected, label) {
  if (status === 429) skip('register rate limit (429)');
  assert.strictEqual(status, expected, `${label}: expected ${expected}, got ${status}`);
}

/**
 * Login is rate limited too (8 per account per 15 min by default). Same
 * reasoning: 429 is the control working, so it is a skip rather than a pass.
 */
function expectLoginRejection(status, expected, label) {
  if (status === 429) skip('login rate limit (429)');
  assert.strictEqual(status, expected, `${label}: expected ${expected}, got ${status}`);
}

async function run() {
  console.log(`\n  auth boundary  ->  ${BASE}\n`);

  // Probe once so a dead server fails with one clear message rather than 20.
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`health returned ${res.status}`);
  } catch (err) {
    console.error(`  API is not reachable at ${BASE} (${err.message}).`);
    console.error('  Start it first:  npm run db:start && npm start\n');
    process.exit(1);
  }

  // ── Anonymous access ────────────────────────────────────
  for (const [method, path] of GUARDED) {
    test(`${method} ${path} rejects anonymous caller with 401`, async () => {
      const { status } = await call(method, path, { body: method === 'POST' ? {} : undefined });
      assert.strictEqual(status, 401, `expected 401, got ${status}`);
    });
  }

  test('public health probe stays public (it must, for monitoring)', async () => {
    const { status } = await call('GET', '/health');
    assert.strictEqual(status, 200);
  });

  test('unknown route is 404, not a crash', async () => {
    const { status } = await call('GET', '/api/definitely-not-a-route');
    assert.strictEqual(status, 404);
  });

  // ── Token handling ──────────────────────────────────────
  test('malformed Authorization header is rejected', async () => {
    const { status } = await call('GET', '/api/auth/me', { token: 'not-a-jwt' });
    assert.strictEqual(status, 401);
  });

  test('non-Bearer scheme is rejected', async () => {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.strictEqual(res.status, 401);
  });

  test('token with a forged signature is rejected', async () => {
    // A structurally valid JWT with a corrupted signature segment must not pass.
    // This proves the signature is actually verified rather than merely decoded.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ id: '000000000000000000000000', tv: 0, exp: Math.floor(Date.now() / 1000) + 999 })
    ).toString('base64url');
    const forged = `${header}.${claims}.${'A'.repeat(43)}`;
    const { status } = await call('GET', '/api/auth/me', { token: forged });
    assert.strictEqual(status, 401, 'a forged signature was accepted');
  });

  test('token signed with the wrong secret is rejected', async () => {
    // A valid HS256 token minted with a different key. Confirms the server
    // verifies against JWT_SECRET and does not accept "any signed token".
    const jwt = require('jsonwebtoken');
    const foreign = jwt.sign({ id: '000000000000000000000000', tv: 0 }, 'not-the-real-secret', {
      expiresIn: '1h',
    });
    const { status } = await call('GET', '/api/auth/me', { token: foreign });
    assert.strictEqual(status, 401, 'a token signed with a foreign key was accepted');
  });

  // ── Real account lifecycle ──────────────────────────────
  let token = null;

  test('register creates an account, or the account already exists', async () => {
    const { status, body } = await call('POST', '/api/auth/register', { body: USER });
    // 201 = freshly created. 409 = a previous run of this suite created it, which
    // is the expected steady state once the register rate limit is in play.
    if (status === 429) skip('register rate limit (429)');
    assert.ok(
      status === 201 || status === 409,
      `unexpected register status ${status}: ${JSON.stringify(body)}`
    );
    if (status === 201) {
      assert.ok(body.token, 'expected a token');
      token = body.token;
    }
  });

  test('the suite account can sign in', async () => {
    if (token) return; // Already have a live token from the register step.
    const { status, body } = await call('POST', '/api/auth/login', {
      body: { email: USER.email, password: USER.password },
    });
    if (status === 429) skip('login rate limit (429)');
    assert.strictEqual(status, 200, `login failed: ${JSON.stringify(body)}`);
    token = body.token;
  });

  test('new token can read protected data', async () => {
    if (!token) skip('no token obtained (rate limited)');
    const { status } = await call('GET', '/api/auth/me', { token });
    assert.strictEqual(status, 200);
  });

  test('duplicate email is refused with 409', async () => {
    // A second account with the SAME email as an existing one must be rejected.
    // Uses a fresh address so this does not depend on the suite account's state.
    const probe = { name: 'Dup Probe', email: `dup${stamp}@walchandsangli.ac.in`, password: 'Dup@12345' };
    const first = await call('POST', '/api/auth/register', { body: probe });
    if (first.status === 429) skip('register rate limit (429)');
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await call('POST', '/api/auth/register', { body: probe });
    assert.strictEqual(second.status, 409, 'duplicate email was accepted');
  });

  test('password is never echoed back by any auth endpoint', async () => {
    const { status, body } = await call('POST', '/api/auth/login', {
      body: { email: USER.email, password: USER.password },
    });
    assert.ok(status === 200 || status === 429, `unexpected login status ${status}`);
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(USER.password), 'password leaked in response');
    assert.ok(!serialised.includes('$2b$'), 'password hash leaked in response');
  });

  test('wrong password is refused with 401', async () => {
    const { status } = await call('POST', '/api/auth/login', {
      body: { email: USER.email, password: 'WrongPassword1' },
    });
    expectLoginRejection(status, 401, 'wrong password');
  });

  test('unknown email is refused with 401', async () => {
    const { status } = await call('POST', '/api/auth/login', {
      body: { email: `nobody${stamp}@walchandsangli.ac.in`, password: 'Whatever@123' },
    });
    expectLoginRejection(status, 401, 'unknown email');
  });

  test('email outside the allowed domain is refused with 403', async () => {
    // Asserted on login rather than register: the domain allowlist is a property
    // of who may sign in at all, and login exercises it without consuming the
    // separate register bucket.
    const { status } = await call('POST', '/api/auth/login', {
      body: { email: `outsider${stamp}@gmail.com`, password: 'Outsider@123' },
    });
    expectLoginRejection(status, 403, 'disallowed domain');
  });

  test('short password is refused with 400', async () => {
    const { status } = await call('POST', '/api/auth/register', {
      body: { name: 'Shorty', email: `short${stamp}@walchandsangli.ac.in`, password: 'abc' },
    });
    expectRegisterRejection(status, 400, 'short password');
  });

  test('oversized password is refused with 400', async () => {
    // Guards against a DoS via bcrypt: bcrypt silently truncates beyond 72
    // bytes, so an unbounded password is both a wasted hash and a false sense
    // of entropy.
    const { status } = await call('POST', '/api/auth/register', {
      body: {
        name: 'Longy',
        email: `long${stamp}@walchandsangli.ac.in`,
        password: 'a'.repeat(500),
      },
    });
    expectRegisterRejection(status, 400, 'oversized password');
  });

  test('missing fields are refused with 400', async () => {
    const { status } = await call('POST', '/api/auth/register', {
      body: { email: `partial${stamp}@walchandsangli.ac.in` },
    });
    expectRegisterRejection(status, 400, 'missing fields');
  });

  test('malformed email is refused with 400', async () => {
    const { status } = await call('POST', '/api/auth/register', {
      body: { name: 'Bad', email: 'not-an-email', password: 'Valid@123' },
    });
    expectRegisterRejection(status, 400, 'malformed email');
  });

  // ── Revocation: the reason tokenVersion exists ──────────
  //
  // These need a live token. Without one they are reported as SKIP, never as a
  // pass - a silently-passing revocation test is exactly the kind of thing that
  // hides a regression.
  test('logout succeeds', async () => {
    if (!token) skip('no token obtained (rate limited)');
    const { status, body } = await call('POST', '/api/auth/logout', { token, body: {} });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.strictEqual(body.revoked, true);
  });

  test('token captured before logout is dead immediately after (server-side revocation)', async () => {
    if (!token) skip('no token obtained (rate limited)');
    const { status, body } = await call('GET', '/api/documents', { token });
    assert.strictEqual(status, 401, `stolen token still worked: ${JSON.stringify(body)}`);
  });

  test('revoked token cannot reach any data route', async () => {
    if (!token) skip('no token obtained (rate limited)');
    for (const [method, path] of [
      ['GET', '/api/auth/me'],
      ['POST', '/api/ask'],
      ['GET', '/api/documents/stats'],
      ['GET', '/api/gdocs/list'],
    ]) {
      const { status } = await call(method, path, { token, body: method === 'POST' ? {} : undefined });
      assert.strictEqual(status, 401, `${method} ${path} accepted a revoked token`);
    }
  });

  test('signing in again after logout works and issues a usable token', async () => {
    if (!token) skip('no token obtained (rate limited)');
    const { status, body } = await call('POST', '/api/auth/login', {
      body: { email: USER.email, password: USER.password },
    });
    if (status === 429) skip('login rate limit (429)');
    assert.strictEqual(status, 200, JSON.stringify(body));
    const me = await call('GET', '/api/auth/me', { token: body.token });
    assert.strictEqual(me.status, 200, 'freshly issued token should work');
    token = body.token;
  });

  test('requireRole is a factory that returns a working middleware', () => {
    const { requireRole } = require('./middleware/auth');
    assert.strictEqual(typeof requireRole, 'function', 'requireRole should be exported');

    // No admin-only route exists yet, so the guard is driven directly. This pins
    // its behaviour so adding one later is a one-line change rather than a
    // rewrite, and catches a regression that would otherwise be invisible until
    // a real admin route is added.
    const adminOnly = requireRole('admin');

    const run = (role) =>
      new Promise((resolve) => {
        const res = {
          statusCode: 200,
          status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; resolve(this); return this; },
        };
        adminOnly({ user: { role } }, res, () => resolve({ statusCode: 200, passed: true }));
      });

    return Promise.all([run('member'), run('admin')]).then(([member, admin]) => {
      assert.strictEqual(member.statusCode, 403, 'a member reached an admin-only route');
      assert.ok(member.body && member.body.error, 'a 403 should carry an error message');
      assert.ok(admin.passed, 'an admin was refused an admin-only route');
    });
  });

  test('cleanup: revoke the suite account', async () => {
    // The suite account is deliberately NOT deleted. It is reused across runs
    // precisely because the register rate limit (5/IP per 15 min) would
    // otherwise make the suite fail on every run after the first. Only the
    // tokens are revoked.
    if (!token) return;
    await call('POST', '/api/auth/logout', { token, body: {} });
  });

  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      if (err instanceof Skipped) {
        skipped += 1;
        console.log(`  SKIP  ${name}  (${err.message})`);
        continue;
      }
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
    }
  }

  console.log(
    `\n${failed ? 'FAILED' : 'OK'}  ${passed} passed, ${failed} failed, ${skipped} skipped\n`
  );
  if (skipped) {
    console.log(
      '  Skips are caused by the auth rate limits (register 5/IP, login 8/account,\n' +
      '  both per 15 minutes). They report honestly as NOT RUN rather than passing.\n' +
      '  For full coverage, start the API with raised limits:\n' +
      '    $env:REGISTER_RATE_MAX=500; $env:LOGIN_RATE_MAX=500; npm start\n\n'
    );
  }
  process.exit(failed ? 1 : 0);
}

run();