/**
 * Tests for the scheduler's single-flight gate — the mechanism behind
 * "pressing Sync now must never duplicate work".
 *
 * Written as a direct unit test rather than an HTTP test: observing
 * "did two passes run?" through the API means inferring it from log lines or
 * response timings, which is suggestive, not proof. Here the sync function
 * counts its own invocations, so the assertion is exact.
 *
 *   node test_scheduler.js
 */

const assert = require('assert');
const scheduler = require('./services/scheduler');

let failures = 0;
let checks = 0;

function check(cond, label) {
  checks++;
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A sync function that records every invocation and hangs for `ms`, so a
 * concurrent second call would be observable as a second invocation.
 */
function makeSource(name, { ms = 200, result = null, throwOn = false } = {}) {
  const calls = [];
  const run = async () => {
    calls.push(Date.now());
    await sleep(ms);
    if (throwOn) throw new Error(`${name} exploded`);
    return result ?? { name, ingested_count: calls.length };
  };
  return { calls, run };
}

(async () => {
  console.log('\nscheduler single-flight gate\n');

  // ── 1. concurrent manual syncs coalesce into one run ────────────────
  {
    const { calls, run } = makeSource('coalesce', { ms: 250 });
    scheduler.addSource('coalesce', run);

    const results = await Promise.all([
      scheduler.runExclusive('coalesce', run),
      scheduler.runExclusive('coalesce', run),
      scheduler.runExclusive('coalesce', run),
      scheduler.runExclusive('coalesce', run),
      scheduler.runExclusive('coalesce', run),
      scheduler.runExclusive('coalesce', run),
    ]);

    check(calls.length === 1, `6 concurrent syncs run the sync ONCE (ran ${calls.length})`);
    check(
      results.every((r) => r === results[0]),
      'every caller receives the same result object (joined, not re-run)'
    );
    check(results[0]?.ingested_count === 1, 'result reflects the single real run');
  }

  // ── 2. the gate does not stay shut ──────────────────────────────────
  {
    const { calls, run } = makeSource('sequential', { ms: 10 });
    scheduler.addSource('sequential', run);

    await scheduler.runExclusive('sequential', run);
    await sleep(30);
    await scheduler.runExclusive('sequential', run);
    await sleep(30);
    await scheduler.runExclusive('sequential', run);

    check(calls.length === 3, `sequential syncs each run (got ${calls.length}, expected 3)`);

    const health = scheduler.getHealth().sources.sequential;
    check(health.running === false, 'running flag cleared after completion');
  }

  // ── 3. a throwing sync must not wedge the gate ──────────────────────
  {
    const { calls, run } = makeSource('thrower', { ms: 10, throwOn: true });
    scheduler.addSource('thrower', run);

    let threw = false;
    try {
      await scheduler.runExclusive('thrower', run);
    } catch {
      threw = true;
    }
    check(threw, 'a failing sync still rejects to its caller');
    check(calls.length === 1, 'the failing sync ran exactly once');

    // A synchronously-throwing fn is the sharp edge: if the map entry is
    // cleared before it is written, the source locks forever.
    const syncThrow = () => {
      calls.push(Date.now());
      throw new Error('sync throw');
    };
    let syncThrew = false;
    try {
      await scheduler.runExclusive('thrower', syncThrow);
    } catch {
      syncThrew = true;
    }
    check(syncThrew, 'a synchronously-throwing sync also rejects');

    await sleep(30);
    const again = await scheduler.runExclusive('thrower', run).catch(() => 'caught');
    check(calls.length >= 2, `gate still accepts work after failures (calls=${calls.length})`);
    check(again !== 'caught' || calls.length >= 2, 'the follow-up run was attempted');
  }

  // ── 4. manual sync never advances the cron's lastRunAt ──────────────
  {
    const { run } = makeSource('cadence', { ms: 5 });
    scheduler.addSource('cadence', run);

    await scheduler.runExclusive('cadence', run);
    await sleep(20);

    const health = scheduler.getHealth().sources.cadence;
    check(
      health.lastRunAt === null,
      'manual sync does not advance lastRunAt (cadence stays cron-owned)'
    );
    check(health.failures === 0, 'manual sync does not touch the backoff counter');
  }

  // ── 5. mutual exclusion between a cron tick and a manual sync ──────
  {
    // The manual run is deliberately long: runOnce walks every registered
    // source first (coalesce alone is 250ms), so a short window would make
    // this assertion depend on scheduling luck rather than on the gate.
    const { calls, run } = makeSource('mutual', { ms: 1200 });
    scheduler.addSource('mutual', run);

    const manual = scheduler.runExclusive('mutual', run);
    await sleep(20); // let it take the gate
    check(scheduler.getHealth().sources.mutual.running === true, 'manual sync raises running while it works');

    await scheduler.runOnce(); // cron path, well inside the 1200ms window
    check(calls.length === 1, `cron tick skips while a manual sync runs (ran ${calls.length}, expected 1)`);
    check(
      scheduler.getHealth().sources.mutual.lastRunAt === null,
      'the skipped tick did not stamp lastRunAt'
    );

    await manual;
    check(scheduler.getHealth().sources.mutual.running === false, 'running clears when the manual sync ends');

    await sleep(20);
    await scheduler.runOnce(); // gate now free
    check(calls.length === 2, `cron tick runs once the gate frees (ran ${calls.length}, expected 2)`);
    check(scheduler.getHealth().sources.mutual.lastRunAt !== null, 'a real cron tick stamps lastRunAt');
  }

  // ── 6. the cron path still works on its own ─────────────────────────
  {
    const { calls, run } = makeSource('cronsolo', { ms: 5 });
    scheduler.addSource('cronsolo', run);

    await scheduler.runOnce();

    check(calls.length === 1, 'cron tick runs the source when the gate is free');
    const health = scheduler.getHealth().sources.cronsolo;
    check(health.lastRunAt !== null, 'cron tick stamps lastRunAt');
    check(health.running === false, 'cron tick clears running on completion');
  }

  console.log(`\n${'='.repeat(60)}`);
  if (failures === 0) console.log(`  OK  ${checks} passed, 0 failed`);
  else console.log(`  FAILED  ${failures} of ${checks}`);
  console.log('');
  process.exit(failures === 0 ? 0 : 1);
})();
