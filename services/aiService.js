/**
 * aiService — Google Gemini access layer.
 *
 * Responsibilities:
 *   1. extractReasoning()  structure a raw source into {summary, decision, reasoning, tags}
 *   2. answerQuestion()    answer a question grounded in retrieved context
 *   3. getEmbedding()      produce a retrieval embedding for ChromaDB
 *
 * Design notes:
 *   - The client is created lazily so a missing key degrades individual routes
 *     instead of preventing the process from booting.
 *   - Every upstream call goes through withRetry(), which honours Gemini's
 *     RetryInfo delay on 429/5xx instead of hammering the quota.
 *   - Blocked / truncated responses are surfaced as typed AiErrors so routes can
 *     choose a fallback rather than silently storing garbage.
 */

const {
  GoogleGenerativeAI,
  TaskType,
  HarmBlockThreshold,
  HarmCategory,
  FinishReason,
} = require('@google/generative-ai');

// Defaults mirror .env.example.
//
// There is no non-preview `gemini-3-flash` — Google only publishes
// gemini-3-flash-preview, and a bare gemini-3-flash returns 404. Flash-Lite is
// the high-throughput model Google recommends for free-tier work, and it
// handles the responseSchema + responseMimeType extraction path correctly,
// including returning the NO_DECISION sentinel when there is no decision.
/**
 * Text models, tried in order.
 *
 * Measured on the free tier, 2026-10-13, repeated calls:
 *   gemini-3.6-flash       2.7s / 3.9s / 3.8s / 4.8s   but intermittent 503
 *   gemini-3.5-flash       1.8s, then two failures
 *   gemini-3.5-flash-lite  43s / 47s / 55s / 78s       reliable but far too slow
 *   gemini-2.5-flash*      404, does not exist
 *
 * So the fast models are fast but lose capacity, and the reliable model is
 * reliable but slower than GEMINI_TIMEOUT_MS. Neither alone works for a live
 * demo: the first fails with 502, the second times out.
 *
 * A fallback chain solves both. Each model has its own quota bucket, so when
 * gemini-3.6-flash returns 503 the request moves to gemini-3.5-flash-lite and
 * still answers - slowly, but it answers. Order matters: the fast model is
 * always tried first, so the common case stays fast and the slow model is only
 * reached when the fast one is unavailable.
 *
 * Override with GEMINI_MODEL (single) or GEMINI_MODEL_FALLBACKS (comma list).
 */
const MODEL_CHAIN = (() => {
  const primary = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const rest = String(process.env.GEMINI_MODEL_FALLBACKS || 'gemini-3.5-flash-lite')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([primary, ...rest])];
})();

const MODEL = MODEL_CHAIN[0];
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';

const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 3);
const BASE_BACKOFF_MS = Number(process.env.GEMINI_BACKOFF_MS || 800);
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 25000);

/**
 * Per-attempt deadline for the SLOWER models in the chain.
 *
 * This has to be separate from REQUEST_TIMEOUT_MS. gemini-3.5-flash-lite was
 * measured at 39-80s per call, so a 40s deadline meant the fallback model could
 * NEVER succeed - every attempt was killed by its own timeout, and the chain
 * degraded to a failed extraction even though the model would eventually have
 * answered. The fallback must be allowed enough time to be a fallback at all.
 *
 * The cost is latency on a bad day, but an answer in 45s beats a 502 in 5s.
 */
const FALLBACK_TIMEOUT_MS = Number(
  process.env.GEMINI_FALLBACK_TIMEOUT_MS || Math.max(REQUEST_TIMEOUT_MS, 90000)
);

/**
 * Wall-clock ceiling across all attempts of one call.
 *
 * MAX_RETRIES x REQUEST_TIMEOUT_MS is the true worst case for a synchronous HTTP
 * request, and it is far too long to hold a browser open: measured against a
 * capacity-saturated Gemini, /api/ask took 181s before the last attempt finally
 * succeeded. Retrying is what rescued it, so the fix is to keep retrying but
 * stop once the caller has clearly waited long enough.
 */
const RETRY_BUDGET_MS = Number(process.env.GEMINI_RETRY_BUDGET_MS || 45000);

/* ──────────────────────────────────────────────────────────
   Errors
   ────────────────────────────────────────────────────────── */
class AiError extends Error {
  constructor(code, message, { cause, status, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const isRetryableStatus = (s) => s === 429 || s === 500 || s === 502 || s === 503 || s === 504;

/**
 * Transport-level failures worth another attempt. A missing HTTP status is not
 * enough on its own to qualify: a TypeError from a bug in our own parsing looks
 * identical at that level, and retrying it just burns the caller's time budget
 * before failing the same way three more times.
 */
const isTransientNetworkError = (err) =>
  err?.name === 'AbortError' ||
  (typeof err?.message === 'string' && /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network/i.test(err.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ──────────────────────────────────────────────────────────
   Client (lazy singleton)
   ────────────────────────────────────────────────────────── */
let genAI = null;

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
}

function getClient() {
  if (!isConfigured()) {
    throw new AiError(
      'NOT_CONFIGURED',
      'GEMINI_API_KEY is missing. Add it to .env before calling any AI route.'
    );
  }
  if (!genAI) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
  }
  return genAI;
}

// Reset cached client (used by tests / after a key rotation).
function resetClient() {
  genAI = null;
}

/**
 * Relaxed-but-present safety thresholds. Organisational email, Slack threads and
 * meeting transcripts legitimately contain aggressive or sensitive phrasing;
 * BLOCK_ONLY_HIGH stops those being silently dropped while keeping a real net.
 */
const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH }));

function buildModel({ systemInstruction, generationConfig } = {}, modelName = MODEL) {
  return getClient().getGenerativeModel({
    model: modelName,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig,
    safetySettings: SAFETY_SETTINGS,
  });
}

/* ──────────────────────────────────────────────────────────
   Retry wrapper
   ────────────────────────────────────────────────────────── */
function retryDelayFrom(error, attempt) {
  // Prefer the server's own RetryInfo when present.
  const details = error?.errorDetails;
  if (Array.isArray(details)) {
    const retry = details.find((d) => d?.retryDelay || d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    const secs = retry?.retryDelay?.seconds;
    if (secs) return Math.min(Number(secs) * 1000 + 500, 30000);
  }
  // Exponential backoff with full jitter.
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, 20000);
  return Math.floor(Math.random() * ceiling) + BASE_BACKOFF_MS;
}

async function withRetry(label, fn) {
  let lastError;
  let attempts = 0;
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attempts = attempt + 1;
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (err instanceof AiError && !err.retryable) throw err;
      if (err?.name === 'AbortError' && attempt > 0) {
        throw new AiError('UPSTREAM_TIMEOUT', `${label} timed out`, { cause: err, retryable: false });
      }

      const status = err?.status;
      if (status && !isRetryableStatus(status)) {
        throw new AiError('UPSTREAM_ERROR', `${label} failed (HTTP ${status}): ${err.message}`, {
          cause: err,
          status,
          retryable: false,
        });
      }
      if (status === 400 || status === 403) {
        throw new AiError('UPSTREAM_REJECTED', `${label} rejected by Gemini (HTTP ${status}): ${err.message}`, {
          cause: err,
          status,
          retryable: false,
        });
      }

      // Anything that is neither a retryable HTTP status nor a transport fault
      // is a defect on our side. Surface it immediately instead of retrying.
      // AiError is exempt: it is already deliberately classified by the layer
      // below, and re-labelling it here loses the specific code (UPSTREAM_TIMEOUT,
      // BLOCKED, BAD_JSON) that the route needs to choose a response.
      if (!(err instanceof AiError) && !status && !isTransientNetworkError(err)) {
        throw new AiError('INTERNAL', `${label} failed: ${err.message}`, {
          cause: err,
          retryable: false,
        });
      }

      if (attempt === MAX_RETRIES) break;

      // Stop once another attempt would push us past the caller's patience.
      const elapsed = Date.now() - startedAt;
      const wait = retryDelayFrom(err, attempt);
      if (elapsed + wait >= RETRY_BUDGET_MS) {
        console.warn(
          `[ai] ${label}: stopping after ${attempts} attempt(s) in ${elapsed}ms ` +
          `(next wait ${wait}ms would exceed the ${RETRY_BUDGET_MS}ms retry budget)`
        );
        break;
      }

      console.warn(`[ai] ${label} attempt ${attempts} failed (${status || err.message}); retrying in ${wait}ms`);
      await sleep(wait);
    }
  }

  throw new AiError(
    'UPSTREAM_UNAVAILABLE',
    `${label} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${lastError?.message}`,
    { cause: lastError, status: lastError?.status, retryable: true }
  );
}

/** Run a generateContent call with a hard timeout, then validate the candidate. */
async function generate({ systemInstruction, prompt, generationConfig }, modelName = MODEL, timeoutMsOverride) {
  const model = buildModel({ systemInstruction, generationConfig }, modelName);

  // The primary model gets the short deadline; anything later in the chain gets
  // the longer one, because the models it falls back to are measurably slower.
  // A caller may override the deadline (the ask path wants a short, user-facing
  // give-up); an overridden deadline is authoritative and is not retried.
  const timeoutMs = timeoutMsOverride ?? (modelName === MODEL ? REQUEST_TIMEOUT_MS : FALLBACK_TIMEOUT_MS);

  /**
   * Deadline is enforced with Promise.race, not AbortController.
   *
   * @google/generative-ai 0.14.x does not forward the requestOptions signal to
   * its fetch: measured with the signal fired at 3s, the promise still resolved
   * 35s later with a complete body. So controller.abort() was a no-op, which
   * meant GEMINI_TIMEOUT_MS never actually bounded anything and UPSTREAM_TIMEOUT
   * could never fire — the one thing standing between a caller and a multi-minute
   * request was not working.
   *
   * Racing stops us *waiting*. It cannot cancel the upstream HTTP request, so a
   * timed-out call still completes at Google and still consumes quota; we just
   * stop holding the caller open for it. An unhandled rejection is swallowed on
   * the losing side so a late arrival does not crash the process.
   */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Gemini request exceeded ${timeoutMs}ms`);
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs);
  });

  const call = model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
  call.catch(() => { /* losing side of the race; already reported by the timer */ });

  let result;
  try {
    result = await Promise.race([call, deadline]);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new AiError('UPSTREAM_TIMEOUT', `Gemini request exceeded ${timeoutMs}ms`, {
        cause: err,
        // With an explicit override (ask path) we are abandoning the caller's
        // patience, so surface the timeout straight to the caller instead of
        // burning retries / falling through the chain.
        retryable: timeoutMsOverride === undefined,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const response = result?.response;
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new AiError('BLOCKED', `Gemini blocked the request (${blockReason})`, { retryable: false });
  }

  const candidate = response?.candidates?.[0];
  if (!candidate) {
    throw new AiError('EMPTY_RESPONSE', 'Gemini returned no candidates', { retryable: true });
  }

  if (candidate.finishReason === FinishReason.SAFETY || candidate.finishReason === FinishReason.RECITATION) {
    throw new AiError('BLOCKED', `Gemini stopped early (${candidate.finishReason})`, { retryable: false });
  }
  if (candidate.finishReason === FinishReason.MAX_TOKENS) {
    console.warn('[ai] response truncated at maxOutputTokens');
  }

  const text = (candidate.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new AiError('EMPTY_RESPONSE', 'Gemini returned an empty body', { retryable: true });
  }
  return text;
}

/**
 * Generate, walking the model chain until one model answers.
 *
 * Each model is attempted through withRetry(), which already handles retries
 * within a single model. This layer handles movement BETWEEN models, which is a
 * different failure: a 429 or 503 means "this model's quota bucket is spent or
 * it has no capacity", and retrying the same model cannot help because the
 * bucket is shared per model, not per call.
 *
 * Only retryable upstream failures advance the chain. A BLOCKED or UPSTREAM_REJECTED
 * error is the same on every model - the prompt is the problem - so failing fast
 * there is correct and keeps a rejected prompt from costing N model attempts.
 *
 * Every model is tried before giving up, so a chain of N models survives N-1
 * capacity failures.
 */
async function generateWithFallback(label, request, timeoutMsOverride) {
  // Guard against a caller passing a thunk instead of a request object. That
  // mistake sends prompt=undefined upstream, which comes back as an opaque HTTP
  // 400 ("parts[0].data: required oneof field") - and because extraction
  // degrades gracefully, the symptom is a silently empty document rather than a
  // crash. Failing loudly here costs nothing and makes the mistake obvious.
  if (typeof request !== 'object' || request === null || typeof request.prompt !== 'string') {
    throw new AiError(
      'INTERNAL',
      `generateWithFallback(${label}) needs a request object with a string prompt, ` +
        `received ${typeof request}`,
      { retryable: false }
    );
  }

  let lastError;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const modelName = MODEL_CHAIN[i];
    try {
      return await withRetry(label, () => generate(request, modelName, timeoutMsOverride));
    } catch (err) {
      lastError = err;

      const advanceable = err instanceof AiError && err.retryable;
      if (!advanceable) throw err;

      const next = MODEL_CHAIN[i + 1];
      if (!next) break;

      console.warn(
        `[ai] ${label}: ${modelName} unavailable (${err.code || err.message}); ` +
          `falling back to ${next}`
      );
    }
  }

  throw lastError;
}

/* ──────────────────────────────────────────────────────────
   JSON helpers
   ────────────────────────────────────────────────────────── */
function parseJsonLoose(raw) {
  if (!raw) throw new AiError('BAD_JSON', 'Gemini returned nothing to parse');

  // Strip markdown fences if the model wrapped the payload.
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    // Last resort: the first balanced object in the string.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    throw new AiError('BAD_JSON', 'Gemini did not return parsable JSON');
  }
}

const asString = (v, fallback = '') =>
  typeof v === 'string' ? v.trim() : v == null ? fallback : String(v).trim();

const asTags = (v) => {
  if (Array.isArray(v)) {
    return v
      .map((t) => (typeof t === 'string' ? t : asString(t)))
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
  }
  return [];
};

const NO_DECISION = 'No decision';

/**
 * Normalise a model's decision string onto the NO_DECISION sentinel.
 *
 * Extracted and exported because this is where a real defect lived: the original
 * called `NO_DECISION.test(decision)`, but NO_DECISION is a plain string, so
 * every *successful* extraction died on a TypeError and the good result was
 * thrown away in favour of the degraded fallback. It only stayed hidden while
 * the provider was refusing every call.
 *
 * Only a genuine string counts. The prompt asks for exactly "No decision" when
 * there is none, so an exact match is the common case; a short phrasing such as
 * "No decision was made" is also accepted, but the phrase must not appear inside
 * a longer real decision such as 'Reviewed the "no decision" template'.
 */
function normaliseDecision(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return NO_DECISION;

  const text = value.trim();
  if (!text) return NO_DECISION;

  // Compare against the whole string first, ignoring case and trailing stops.
  const bare = text.replace(/[.!?]+$/, '').trim();
  if (bare.toLowerCase() === NO_DECISION.toLowerCase()) return NO_DECISION;

  const containsSentinel = /\bno\s+decision\b/i.test(text);
  if (containsSentinel && text.length <= 40) return NO_DECISION;

  return text.slice(0, 600);
}

/* ──────────────────────────────────────────────────────────
   1 · Extraction
   ────────────────────────────────────────────────────────── */
const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'One sentence describing what this content is about.' },
    decision: { type: 'STRING', description: 'The concrete decision made, or "No decision" if none.' },
    reasoning: { type: 'STRING', description: 'Why that decision was made, or the key insight.' },
    tags: { type: 'ARRAY', items: { type: 'STRING' }, description: '2-5 short topical tags.' },
  },
  required: ['summary', 'decision', 'reasoning', 'tags'],
};

async function extractReasoning(content, source) {
  const text = asString(content);
  if (!text) {
    return { summary: '', decision: NO_DECISION, reasoning: '', tags: [], degraded: 'empty_input' };
  }

  const prompt = [
    `You are the knowledge-extraction layer for an organisational memory system.`,
    `The content below came from: ${asString(source, 'unknown source')}.`,
    ``,
    `Return a JSON object with exactly these keys:`,
    `  summary    - one line, max 200 characters, describing what this content is about.`,
    `  decision   - the specific decision that was made and who/what it affects.`,
    `              If the content contains no decision at all, return the string "No decision".`,
    `              Never invent a decision that is not stated.`,
    `  reasoning  - why that decision was made, or the single most important insight.`,
    `  tags       - 2 to 5 lowercase topical tags. No spaces, no duplicates.`,
    ``,
    `--- CONTENT ---`,
    text,
    `--- END CONTENT ---`,
  ].join('\n');

  try {
    const raw = await generateWithFallback('extractReasoning', {
      systemInstruction:
        'You extract structured organisational knowledge. You always answer with valid JSON and never invent facts.',
      prompt,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseSchema: EXTRACTION_SCHEMA,
      },
    });

    const parsed = parseJsonLoose(raw);

    return {
      summary: asString(parsed.summary).slice(0, 400),
      decision: normaliseDecision(parsed.decision),
      reasoning: asString(parsed.reasoning).slice(0, 2000),
      tags: asTags(parsed.tags),
    };
  } catch (err) {
    // A degraded extraction must never lose the document. Fall back to
    // deterministic text so the source is still searchable.
    console.error(`[ai] extractReasoning failed (${err.code || err.name}): ${err.message}`);
    return {
      summary: text.replace(/\s+/g, ' ').slice(0, 200),
      decision: NO_DECISION,
      reasoning: 'Automatic reasoning extraction was unavailable for this item.',
      tags: [],
      degraded: err.code || 'error',
    };
  }
}

/* ──────────────────────────────────────────────────────────
   2 · Grounded answering
   ────────────────────────────────────────────────────────── */
const SYSTEM_PROMPT = [
  'You are the answering layer of an organisational memory system.',
  'You receive numbered context blocks that were retrieved from the company archive.',
  '',
  'Rules you must follow:',
  '- Answer ONLY from the provided context. Never use outside knowledge.',
  '- Every factual claim must cite the context block it came from, like [1] or [2].',
  '- If a block shows both a Decision and a Previous decision, the Decision is the',
  '  latest state: state it as current, and when the change is relevant to the',
  '  question also name the Previous decision as what was believed before.',
  '- A Previous decision that carries an "earlier item" attribution came from an',
  '  earlier message in the same thread, not from the same document.',
  '- If the context does not contain the answer, reply exactly:',
  '  "I could not find that in the indexed sources."',
  '- Be concise and factual. No preamble, no restating the question.',
].join('\n');

const CHARS_PER_TOKEN = 4; // conservative estimate
const CONTEXT_CHAR_BUDGET = Number(process.env.ASK_CONTEXT_CHARS || 24000);

/**
 * How long /api/ask waits for Gemini before giving the user a friendly
 * "Gemini is busy, try again in a moment" reply instead of holding the request
 * open through retries / long fallbacks. Keep this in sync with
 * ASK_GEMINI_TIMEOUT_MS in .env.
 */
const ASK_GEMINI_TIMEOUT_MS = Number(process.env.ASK_GEMINI_TIMEOUT_MS || 30000);

/**
 * Build a character-budgeted context block list. Longest documents are trimmed
 * rather than dropped so we never silently lose the best match.
 */
function buildContext(contextDocs) {
  const blocks = [];
  let budget = CONTEXT_CHAR_BUDGET;
  const ordered = [...contextDocs].sort(
    (a, b) => (b.rawContent?.length || 0) - (a.rawContent?.length || 0)
  );

  for (const doc of ordered) {
    const raw = asString(doc.rawContent);
    if (!raw) continue;

    const history = Array.isArray(doc.decisionHistory) ? doc.decisionHistory : [];
    const previous = history.length ? history[history.length - 1] : null;
    const header = [
      `[${blocks.length + 1}] Source: ${asString(doc.source, 'unknown').toUpperCase()}`,
      `Title: ${asString(doc.title, 'untitled')}`,
      doc.decision && doc.decision !== NO_DECISION ? `Decision: ${asString(doc.decision)}` : null,
      // The model cannot mention a supersession it cannot see. When the
      // archive recorded that a decision changed, both values go into context
      // so the answer can say "latest is X, previously Y" instead of only X.
      previous
        ? `Previous decision: ${asString(previous.text)}${
            previous.decidedAt ? ` (superseded ${asString(previous.decidedAt)})` : ''
          }${previous.fromTitle ? ` — from earlier item: ${asString(previous.fromTitle)}` : ''}`
        : null,
      doc.summary ? `Summary: ${asString(doc.summary)}` : null,
      `---`,
    ]
      .filter(Boolean)
      .join('\n');

    const allowance = Math.max(0, budget - header.length);
    if (allowance <= 0) break;

    const truncated = raw.length > allowance;
    const body = truncated ? `${raw.slice(0, allowance)}\n[…truncated]` : raw;

    blocks.push({ doc, text: `${header}\n${body}` });
    budget -= header.length + body.length;

    if (budget <= 0) break;
  }

  return blocks;
}

/**
 * `refs`, when given, carries the ORIGINAL block number for each document.
 *
 * When a question only cites some of the retrieved blocks, the payload is
 * filtered down — and renumbering from 1 would make the source list disagree
 * with the citations in the answer ("cites [4] [5], list reads [1] [2]").
 * Pass the real block numbers through so the two stay in step.
 */
function toCitationPayload(sources, refs) {
  return sources.map((doc, i) => {
    const history = Array.isArray(doc.decisionHistory) ? doc.decisionHistory : [];
    return {
      ref: refs ? refs[i] : i + 1,
      docId: String(doc._id),
      title: asString(doc.title, 'untitled'),
      source: asString(doc.source, 'unknown'),
      summary: asString(doc.summary),
      decision: asString(doc.decision),
      reasoning: asString(doc.reasoning),
      createdAt: doc.createdAt,
      // Surfaced so the chat can label the decision as changed ("latest vs
      // previously") without a second round-trip to Mongo.
      previousDecision: history.length ? asString(history[history.length - 1].text) : null,
      decisionChangedAt: history.length ? asString(history[history.length - 1].decidedAt) : null,
      decisionFromTitle: history.length ? asString(history[history.length - 1].fromTitle) : null,
      decisionVersion: history.length + 1,
    };
  });
}

/**
 * Block numbers the model actually referenced, e.g. "[1]", "[2, 5]".
 *
 * Models do not always emit one citation per block — "[1, 4]" is at least as
 * common as "[1] [4]" — so the match has to tolerate comma/space separated
 * lists inside a single bracket. Getting this wrong silently drops every
 * source, which is worse than showing too many.
 *
 * `buildContext` numbers blocks in the order it emits them, which is
 * longest-document-first, NOT the order of the retrieved list. Callers must
 * therefore map these numbers through the block list, not array indices.
 */
function citedBlockRefs(answer) {
  const refs = new Set();
  for (const group of asString(answer).matchAll(/\[([\d,\s]+)\]/g)) {
    for (const part of group[1].split(/[,\s]+/)) {
      if (!part) continue;
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1) refs.add(n);
    }
  }
  return refs;
}

async function answerQuestion(question, contextDocs) {
  const q = asString(question);
  if (!q) throw new AiError('BAD_REQUEST', 'question is required');
  if (!Array.isArray(contextDocs) || contextDocs.length === 0) {
    throw new AiError('NO_CONTEXT', 'No context documents were supplied');
  }

  const blocks = buildContext(contextDocs);
  if (blocks.length === 0) {
    throw new AiError('NO_CONTEXT', 'Context documents contained no readable text');
  }

  const context = blocks.map((b) => b.text).join('\n\n');
  const prompt = `CONTEXT\n${context}\nEND CONTEXT\n\nQUESTION: ${q}\n\nAnswer using only the context above, citing block numbers.`;

  const raw = await generateWithFallback('answerQuestion', {
    systemInstruction: SYSTEM_PROMPT,
    prompt,
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  }, ASK_GEMINI_TIMEOUT_MS);

  // Only surface the blocks the model actually leaned on. Returning every
  // retrieved document meant a two-line answer arrived with a wall of
  // citations, most unrelated to what was asked. If it cited nothing (an
  // abstention, or a generic reply) the source list is correctly empty.
  //
  // The original block numbers travel with each doc so the list still lines up
  // with the [n] markers in the answer.
  const cited = citedBlockRefs(raw);
  const kept = blocks
    .map((b, i) => ({ doc: b.doc, ref: i + 1 }))
    .filter((b) => cited.has(b.ref));

  return {
    answer: raw,
    sources: toCitationPayload(
      kept.map((k) => k.doc),
      kept.map((k) => k.ref)
    ),
  };
}

/* ──────────────────────────────────────────────────────────
   3 · Embeddings
   ────────────────────────────────────────────────────────── */
let embedModel = null;

function getEmbedModel() {
  if (!embedModel) {
    embedModel = getClient().getGenerativeModel({ model: EMBED_MODEL });
  }
  return embedModel;
}

const EMBED_TASK = {
  document: TaskType.RETRIEVAL_DOCUMENT,
  query: TaskType.RETRIEVAL_QUERY,
};

/**
 * Returns a plain number[] for ChromaDB, or [] on failure so callers can fall
 * back to keyword search instead of 500-ing the request.
 */
async function getEmbedding(text, { task = 'document' } = {}) {
  const input = asString(text);
  if (!input) return [];

  try {
    const model = getEmbedModel();
    const res = await withRetry('getEmbedding', () =>
      model.embedContent({
        content: { role: 'user', parts: [{ text: input.slice(0, 8000) }] },
        taskType: EMBED_TASK[task] || TaskType.RETRIEVAL_DOCUMENT,
      })
    );
    const values = res?.embedding?.values;
    return Array.isArray(values) && values.length ? values.map(Number) : [];
  } catch (err) {
    console.error(`[ai] getEmbedding failed (${err.code || err.name}): ${err.message}`);
    return [];
  }
}

/** Diagnostics for the health endpoint. */
function describe() {
  return {
    provider: 'gemini',
    model: MODEL,
    modelChain: MODEL_CHAIN,
    embedModel: EMBED_MODEL,
    configured: isConfigured(),
    maxRetries: MAX_RETRIES,
    timeoutMs: REQUEST_TIMEOUT_MS,
    fallbackTimeoutMs: FALLBACK_TIMEOUT_MS,
    retryBudgetMs: RETRY_BUDGET_MS,
  };
}

module.exports = {
  extractReasoning,
  answerQuestion,
  getEmbedding,
  // helpers
  isConfigured,
  describe,
  resetClient,
  normaliseDecision,
  // Exported for tests: these decide WHAT the model sees (latest + previous
  // decision) and WHAT the UI receives, so they are worth pinning down offline.
  buildContext,
  toCitationPayload,
  AiError,
  NO_DECISION,
};
