/**
 * Tests for chatStore.js — the conversation history that must survive route
 * changes and disappear on sign-out.
 *
 * sessionStorage does not exist in Node, so a minimal in-memory stub stands in
 * for it. The stub is deliberately strict: it can be told to throw, which is
 * how the "storage unavailable / quota exceeded" branches are exercised.
 *
 *   node test_chatstore.mjs
 */

let failures = 0;
let checks = 0;

function ok(condition, label) {
  checks++;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
}

/** In-memory sessionStorage with optional failure injection. */
function makeStorage({ throwOnSet = false, throwOnGet = false, throwOnRemove = false } = {}) {
  const map = new Map();
  return {
    getItem(k) {
      if (throwOnGet) throw new Error('SecurityError: storage disabled');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnSet) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, String(v));
    },
    removeItem(k) {
      if (throwOnRemove) throw new Error('SecurityError: storage disabled');
      map.delete(k);
    },
    _map: map,
  };
}

const { loadMessages, saveMessages, clearMessages } = await import('./src/chatStore.js');

console.log('\nchatStore');

// ── round trip ──────────────────────────────────────────────────────────
{
  global.sessionStorage = makeStorage();
  const msgs = [
    { role: 'user', content: 'what are the kickoff requirements?' },
    { role: 'ai', content: 'Centralized inventory visibility', sources: [{ ref: 1, title: 'Kickoff' }] },
  ];
  saveMessages('user-a', msgs);
  const back = loadMessages('user-a');
  ok(back.length === 2, 'save/load round trip preserves every message');
  ok(back[1].sources[0].title === 'Kickoff', 'nested sources survive serialisation');
  ok(back[0].content === 'what are the kickoff requirements?', 'message text is intact');
}

// ── missing key ─────────────────────────────────────────────────────────
{
  global.sessionStorage = makeStorage();
  ok(Array.isArray(loadMessages('nobody')) && loadMessages('nobody').length === 0, 'unknown account loads []');
}

// ── per-account isolation ───────────────────────────────────────────────
{
  global.sessionStorage = makeStorage();
  saveMessages('user-a', [{ role: 'user', content: 'A private question' }]);
  saveMessages('user-b', [{ role: 'user', content: 'B private question' }]);

  const a = loadMessages('user-a');
  const b = loadMessages('user-b');
  ok(a.length === 1 && a[0].content.includes('A private'), "user A sees only A's history");
  ok(b.length === 1 && b[0].content.includes('B private'), "user B sees only B's history");
  ok(!JSON.stringify(a).includes('B private'), 'no leakage across accounts');

  clearMessages('user-a');
  ok(loadMessages('user-a').length === 0, 'clearMessages empties the target account');
  ok(loadMessages('user-b').length === 1, 'clearMessages leaves other accounts alone');
}

// ── empty conversation clears rather than storing a ghost ───────────────
{
  global.sessionStorage = makeStorage();
  saveMessages('user-a', [{ role: 'user', content: 'hi' }]);
  saveMessages('user-a', []);
  ok(loadMessages('user-a').length === 0, 'saving an empty list clears storage');
}

// ── no account id falls back to a stable shared key ─────────────────────
{
  global.sessionStorage = makeStorage();
  saveMessages(undefined, [{ role: 'user', content: 'anon' }]);
  ok(loadMessages(undefined).length === 1, 'undefined id writes to the anonymous key');
  ok(loadMessages(null).length === 1, 'null id reads the same anonymous key');
}

// ── corrupt payload ─────────────────────────────────────────────────────
{
  global.sessionStorage = makeStorage();
  global.sessionStorage.setItem('trace_chat:v1:user-a', '{not valid json');
  let threw = false;
  let result;
  try {
    result = loadMessages('user-a');
  } catch {
    threw = true;
  }
  ok(!threw && Array.isArray(result) && result.length === 0, 'corrupt JSON loads [] instead of throwing');
}

// ── hostile storage: every operation throws ─────────────────────────────
{
  global.sessionStorage = makeStorage({ throwOnSet: true, throwOnGet: true, throwOnRemove: true });
  let threw = false;
  try {
    saveMessages('user-a', [{ role: 'user', content: 'hi' }]);
    loadMessages('user-a');
    clearMessages('user-a');
  } catch {
    threw = true;
  }
  ok(!threw, 'disabled storage degrades quietly — nothing throws');
}

// ── quota exceeded mid-send ─────────────────────────────────────────────
{
  global.sessionStorage = makeStorage({ throwOnSet: true });
  let threw = false;
  try {
    saveMessages('user-a', [{ role: 'user', content: 'hi' }]);
  } catch {
    threw = true;
  }
  ok(!threw, 'QuotaExceededError on save does not surface to the UI');
}

// ── unbounded growth cap ────────────────────────────────────────────────
{
  global.sessionStorage = makeStorage();
  const many = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  saveMessages('user-a', many);
  const back = loadMessages('user-a');
  ok(back.length <= 120, `history is capped (got ${back.length}, cap 120)`);
  ok(back[back.length - 1].content === 'msg 499', 'newest messages are the ones kept');
}

// ── non-array junk never propagates ─────────────────────────────────────
{
  global.sessionStorage = makeStorage();
  global.sessionStorage.setItem('trace_chat:v1:user-a', '"a string"');
  const r = loadMessages('user-a');
  ok(Array.isArray(r) && r.length === 0, 'a non-array payload loads []');
}

console.log(`\n${'='.repeat(60)}`);
console.log(failures === 0 ? `  OK  ${checks} passed, 0 failed` : `  FAILED  ${failures} of ${checks}`);
console.log('');
process.exit(failures === 0 ? 0 : 1);
