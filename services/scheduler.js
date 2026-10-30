/**
 * scheduler — one background poller for every source.
 *
 * Previously each route module registered its own `node-cron` job, which meant:
 *   - three timers firing on the same second and competing for the Gemini quota
 *   - no single-flight guard, so a slow sync could overlap with the next tick
 *   - no backoff, so a disconnected integration logged an error every minute
 *   - no way to disable polling in development
 *
 * This module owns a single timer, runs sources sequentially, skips a source
 * that is still running, and applies exponential backoff after failures.
 */

const cron = require('node-cron');

const INTERVAL = process.env.CRON_INTERVAL || '*/2 * * * *';
const ENABLED = process.env.DISABLE_CRON !== 'true';
const MAX_BACKOFF_MINUTES = Number(process.env.CRON_MAX_BACKOFF_MIN || 30);
const STAGGER_MS = Number(process.env.CRON_STAGGER_MS || 1500);

const health = {};

/**
 * In-flight runs, keyed by source name. This is the single gate the cron tick
 * and the manual "Sync now" endpoints share.
 *
 * Pressing Sync now while a cron tick was mid-pass used to start a *second*
 * pass over the same messages. Nothing was ever stored twice — Mongo's unique
 * partial indexes turn the collision into an E11000 and Chroma upserts by
 * docId — but the work ran twice and every overlap logged a lost race.
 *
 * A manual call made while a run is in flight now joins that run rather than
 * starting another: the sync is already happening, so there is nothing to
 * begin and nothing to duplicate.
 */
const flights = new Map();

function getHealth() {
  return {
    enabled: ENABLED,
    interval: INTERVAL,
    sources: { ...health },
  };
}

/**
 * Run `fn` for `name` under the shared gate, or join the run already there.
 *
 * `Promise.resolve().then(fn)` deliberately defers `fn` to a microtask: the map
 * entry has to exist before `fn` can settle, or a synchronously-throwing `fn`
 * would clear an entry that was never written and wedge the source shut.
 *
 * @param {string} name
 * @param {() => any} fn
 * @returns {Promise<any>} this run's result, or the in-flight run's result
 */
function withLock(name, fn) {
  const pending = flights.get(name);
  if (pending) return pending;

  const run = Promise.resolve()
    .then(fn)
    .finally(() => flights.delete(name));

  flights.set(name, run);
  return run;
}

/**
 * Manual entry point for "Sync now".
 *
 * Deliberately NOT the cron tick, because the two have different policies:
 *
 *   - a manual sync ignores the backoff window. Someone clicking the button is
 *     telling you they want it now; making them wait out a 4-minute penalty
 *     for an earlier failure is the opposite of what the button promises.
 *   - a manual sync does not advance `lastRunAt`, which belongs to the cron
 *     schedule alone. Pushing once must not shift the automatic cadence.
 *
 * It does set `running` for the duration, and only when it is the run actually
 * doing the work — joining a cron tick leaves that tick's flag to its owner.
 *
 * @param {string} name registered source name: gmail | slack | google_docs
 * @param {() => any} fn
 */
async function runExclusive(name, fn) {
  const state = health[name];

  if (flights.has(name)) return flights.get(name);

  if (state) state.running = true;
  try {
    return await withLock(name, fn);
  } finally {
    if (state) state.running = false;
  }
}

/**
 * Wrap a source's sync function with single-flight + backoff behaviour.
 * @param {string} name
 * @param {() => Promise<{ingested_count?: number}>} run
 * @param {{ isAvailable: () => boolean }} opts
 */
function registerSource(name, run, { isAvailable = () => true } = {}) {
  const state = { running: false, failures: 0, lastRunAt: null, lastResult: null, lastError: null, nextEligibleAt: 0 };
  health[name] = state;

  return async function tick() {
    // `running` is set by whichever side owns the gate, so this guard covers a
    // manual sync in progress as well as a previous tick. Both sides set it
    // synchronously before registering, so there is no window where each could
    // pass its own check.
    if (state.running) {
      console.log(`[cron] ${name}: previous run still in progress, skipping this tick`);
      return;
    }
    if (Date.now() < state.nextEligibleAt) return;
    if (!isAvailable()) return;

    state.running = true;
    state.lastRunAt = new Date().toISOString();

    try {
      // Same lock the manual endpoints use, so a Sync now pressed mid-tick
      // coalesces onto this run instead of racing it.
      const result = await withLock(name, run);
      state.failures = 0;
      state.nextEligibleAt = 0;
      state.lastError = null;
      state.lastResult = result ?? null;

      const n = result?.ingested_count ?? 0;
      if (n > 0) console.log(`[cron] ${name}: ingested ${n} new item(s)`);
    } catch (err) {
      state.failures += 1;
      state.lastError = err?.message || String(err);

      // 1m, 2m, 4m, 8m … capped, so a dead integration stops flooding the log.
      const minutes = Math.min(2 ** state.failures, MAX_BACKOFF_MINUTES);
      state.nextEligibleAt = Date.now() + minutes * 60_000;

      console.error(`[cron] ${name} failed (${state.lastError}); next attempt in ${minutes}m`);
    } finally {
      state.running = false;
    }
  };
}

let task = null;
const registered = [];

/** Register a source. Order here is the execution order within a tick. */
function addSource(name, run, opts) {
  registered.push(registerSource(name, run, opts));
}

async function runOnce() {
  for (const fn of registered) {
    try {
      await fn();
    } catch (err) {
      // registerSource already captured this; this guard prevents one bad
      // source from aborting the rest of the tick.
      console.error(`[cron] unhandled error: ${err?.message || err}`);
    }
    // Small gap so three integrations never hit Gemini in the same instant.
    if (registered.length > 1) await new Promise((r) => setTimeout(r, STAGGER_MS));
  }
}

function start() {
  if (!ENABLED) {
    console.log('[cron] disabled via DISABLE_CRON=true');
    return null;
  }
  if (task) return task;

  task = cron.schedule(INTERVAL, () => { void runOnce(); });
  console.log(`[cron] scheduler started (${INTERVAL}) for: ${Object.keys(health).join(', ') || 'no sources'}`);
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    console.log('[cron] scheduler stopped');
  }
}

module.exports = { addSource, start, stop, runOnce, getHealth, runExclusive };
