/**
 * test_smoke.js — offline checks for the pure logic in the API layer.
 *
 *   npm run test:smoke
 *
 * No credentials, no network and no database required. These are the functions
 * that were silently wrong before, so they are the ones worth pinning down.
 */

require('dotenv').config();

const assert = require('assert');

const { extractBody } = require('./routes/gmail');
const { extractTextFromDoc } = require('./routes/gdocs');

let passed = 0;
let failed = 0;
const queue = [];

/** Queue a test; async bodies are awaited so failures are actually caught. */
function test(name, fn) {
  queue.push({ name, fn });
}

async function run() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`      ${err.message}`);
    }
  }

  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

/* ──────────────────────────────────────────────────────────
   Gmail MIME extraction
   ────────────────────────────────────────────────────────── */
console.log('\ngmail · MIME body extraction');

test('reads a simple text/plain body', () => {
  const body = extractBody({
    mimeType: 'text/plain',
    body: { data: b64('Hello team, shipping on Friday.') },
  });
  assert.strictEqual(body, 'Hello team, shipping on Friday.');
});

test('finds text/plain nested inside multipart/mixed', () => {
  // This is the case the old top-level-only walker silently dropped.
  const body = extractBody({
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'application/pdf', filename: 'deck.pdf', body: { attachmentId: 'x' } },
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('The real body text.') } },
          { mimeType: 'text/html', body: { data: b64('<p>The <b>real</b> body text.</p>') } },
        ],
      },
    ],
  });
  assert.strictEqual(body, 'The real body text.');
});

test('falls back to HTML when no text/plain part exists', () => {
  const body = extractBody({
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/html', body: { data: b64('<div>Line one<br/>Line two</div>') } }],
  });
  assert.strictEqual(body, 'Line one\nLine two');
});

test('strips quoted reply history', () => {
  const body = extractBody({
    mimeType: 'text/plain',
    body: {
      data: b64(
        'Sounds good to me.\n\nOn Mon, 1 Jan 2024 at 10:00, Someone <s@x.com> wrote:\n> the old question\n'
      ),
    },
  });
  assert.ok(body.startsWith('Sounds good to me.'), 'kept the new reply');
  assert.ok(!body.includes('the old question'), 'dropped the quoted text');
});

test('returns empty string when there is no text at all', () => {
  const body = extractBody({
    mimeType: 'multipart/mixed',
    parts: [{ mimeType: 'image/png', body: { attachmentId: 'y' } }],
  });
  assert.strictEqual(body, '');
});

/* ──────────────────────────────────────────────────────────
   Google Docs text extraction
   ────────────────────────────────────────────────────────── */
console.log('\ngoogle docs · text extraction');

test('joins paragraphs with blank lines', () => {
  const text = extractTextFromDoc({
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'First para\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: 'Second para\n' } }] } },
      ],
    },
  });
  assert.strictEqual(text, 'First para\n\nSecond para');
});

test('includes table cell content', () => {
  // The old walker never descended into tables.
  const text = extractTextFromDoc({
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'Budget\n' } }] } },
        {
          table: {
            tableRows: [
              { tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Item' } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Cost' } }] } }] },
              ] },
              { tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Servers' } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: '1200' } }] } }] },
              ] },
            ],
          },
        },
      ],
    },
  });
  assert.ok(text.includes('Servers | 1200'), `table row missing, got: ${JSON.stringify(text)}`);
});

test('handles nested tables', () => {
  const text = extractTextFromDoc({
    body: {
      content: [
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  {
                    content: [
                      {
                        table: {
                          tableRows: [
                            { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Deep' } }] } }] }] },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  assert.ok(text.includes('Deep'), 'nested table cell missing');
});

test('returns empty string for an empty document', () => {
  assert.strictEqual(extractTextFromDoc({ body: { content: [] } }), '');
  assert.strictEqual(extractTextFromDoc({}), '');
});

/* ──────────────────────────────────────────────────────────
   AI service guards (no network)
   ────────────────────────────────────────────────────────── */
console.log('\nai service · configuration guards');

test('reports NOT_CONFIGURED when the key is absent', async () => {
  const { isConfigured, extractReasoning, getEmbedding, AiError } = require('./services/aiService');
  assert.strictEqual(typeof isConfigured(), 'boolean');

  if (isConfigured()) return; // key present in this shell; skip the assertion

  const extraction = await extractReasoning('some text', 'test');
  assert.strictEqual(extraction.degraded, 'NOT_CONFIGURED');
  assert.strictEqual(extraction.decision, 'No decision');
  assert.ok(Array.isArray(extraction.tags));

  const embedding = await getEmbedding('some text');
  assert.deepStrictEqual(embedding, [], 'embeddings must degrade to [] not throw');

  assert.ok(AiError.prototype instanceof Error);
});

/* ──────────────────────────────────────────────────────────
   Decision normalisation
   ────────────────────────────────────────────────────────── */
console.log('\nai service · decision normalisation');

test('a real decision survives intact', () => {
  const { normaliseDecision, NO_DECISION } = require('./services/aiService');
  const d = 'Move the deployment pipeline from Jenkins to GitHub Actions';
  assert.strictEqual(normaliseDecision(d), d);
  assert.notStrictEqual(normaliseDecision(d), NO_DECISION);
});

test('"no decision" collapses onto the sentinel', () => {
  const { normaliseDecision, NO_DECISION } = require('./services/aiService');
  // Regression: the original called NO_DECISION.test(...) on a string, which
  // threw a TypeError and discarded every successful extraction.
  assert.strictEqual(typeof NO_DECISION, 'string', 'sentinel must stay a plain string');
  for (const v of ['No decision', 'no decision', 'NO DECISION', 'No  Decision']) {
    assert.strictEqual(normaliseDecision(v), NO_DECISION, `failed for ${JSON.stringify(v)}`);
  }
});

test('empty, missing and non-string decisions become the sentinel', () => {
  const { normaliseDecision, NO_DECISION } = require('./services/aiService');
  for (const v of ['', '   ', null, undefined, {}, [], true, NaN]) {
    assert.strictEqual(normaliseDecision(v), NO_DECISION, `failed for ${JSON.stringify(v)}`);
  }
});

test('a short "no decision" phrasing is still treated as the sentinel', () => {
  const { normaliseDecision, NO_DECISION } = require('./services/aiService');
  for (const v of ['No decision was made.', 'no decision here', 'NO DECISION']) {
    assert.strictEqual(normaliseDecision(v), NO_DECISION, `failed for ${JSON.stringify(v)}`);
  }
});

test('a decision that merely mentions the phrase is preserved', () => {
  const { normaliseDecision } = require('./services/aiService');
  const d = 'Reviewed the "no decision" template and rejected it in favour of a new form';
  assert.strictEqual(normaliseDecision(d), d);
});

/* ──────────────────────────────────────────────────────────
   Decision history
   ────────────────────────────────────────────────────────── */
console.log('\ningest · decision history');

const {
  appendSuperseded,
  isRealDecision,
  DECISION_HISTORY_MAX,
  NO_DECISION,
} = require('./services/ingestService');

test('the "No decision" sentinel is not a decision worth recording', () => {
  assert.strictEqual(isRealDecision(NO_DECISION), false);
  assert.strictEqual(isRealDecision(''), false);
  assert.strictEqual(isRealDecision(null), false);
  assert.strictEqual(isRealDecision('  '), false);
  assert.strictEqual(isRealDecision('Ship on Friday'), true);
});

test('a superseded decision is appended, oldest first', () => {
  const out = appendSuperseded([], { text: 'Ship Friday', decidedAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, 'Ship Friday');
  assert.strictEqual(out[0].decidedAt, '2026-01-01T00:00:00.000Z');
});

test('re-saving the same decision does not grow the list', () => {
  const seeded = [{ text: 'Ship Friday', summary: '', decidedAt: '' }];
  assert.strictEqual(appendSuperseded(seeded, { text: 'Ship Friday' }).length, 1);
  assert.strictEqual(appendSuperseded(seeded, { text: '  Ship Friday  ' }).length, 1);
});

test('the sentinel is never appended', () => {
  assert.strictEqual(appendSuperseded([], { text: NO_DECISION }).length, 0);
});

test('a chain of changes keeps the most recent entries', () => {
  let list = [];
  for (let i = 1; i <= DECISION_HISTORY_MAX + 5; i++) {
    list = appendSuperseded(list, { text: `decision ${i}`, decidedAt: `t${i}` });
  }
  assert.strictEqual(list.length, DECISION_HISTORY_MAX);
  assert.strictEqual(list[0].text, 'decision 6', 'oldest entry should be dropped first');
  assert.strictEqual(list[list.length - 1].text, `decision ${DECISION_HISTORY_MAX + 5}`);
});

test('thread attribution survives the append', () => {
  const out = appendSuperseded([], {
    text: 'Budget approved',
    summary: 's',
    decidedAt: '2026-02-01T00:00:00.000Z',
    fromDocId: 'abc123',
    fromTitle: 'Budget thread - earlier mail',
  });
  assert.strictEqual(out[0].fromDocId, 'abc123');
  assert.strictEqual(out[0].fromTitle, 'Budget thread - earlier mail');
});

console.log('\nanswering · latest vs previous decision');

test('the model receives both the latest and the previous decision', () => {
  const { buildContext } = require('./services/aiService');
  const blocks = buildContext([{
    _id: '656f00000000000000000001',
    source: 'google_docs',
    title: 'Shipping Policy',
    rawContent: 'Policy body text.',
    summary: 'Policy summary',
    decision: 'Decision C - no Friday shipping',
    decisionHistory: [
      { text: 'Decision A - ship on Fridays', decidedAt: '2026-10-30T10:18:44.426Z', summary: '', fromDocId: '', fromTitle: '' },
      { text: 'Decision B - ship on Wednesdays', decidedAt: '2026-10-30T10:18:44.542Z', summary: '', fromDocId: '', fromTitle: '' },
    ],
  }]);
  assert.strictEqual(blocks.length, 1);
  const header = blocks[0].text.split('\n')[0] + blocks[0].text.split('\n').slice(1, 5).join('\n');
  assert.ok(header.includes('Decision: Decision C - no Friday shipping'), 'latest decision missing from context');
  // Only the immediately-preceding decision is injected: the prompt needs
  // "what changed", not the full audit trail.
  assert.ok(header.includes('Previous decision: Decision B - ship on Wednesdays'), 'previous decision missing from context');
  assert.ok(header.includes('superseded 2026-10-30T10:18:44.542Z'), 'supersession time missing');
  assert.ok(!header.includes('Decision A'), 'only the immediately-previous decision belongs in context');
});

test('a threaded previous decision carries its origin title', () => {
  const { buildContext } = require('./services/aiService');
  const blocks = buildContext([{
    _id: '656f00000000000000000002',
    source: 'gmail',
    title: 'Re: Budget thread',
    rawContent: 'body',
    decision: 'Approved 4L budget',
    decisionHistory: [
      { text: 'Approved 2L budget', decidedAt: '2026-01-01T00:00:00.000Z', summary: '', fromDocId: 'x', fromTitle: 'Budget thread - earlier mail' },
    ],
  }]);
  assert.ok(blocks[0].text.includes('from earlier item: Budget thread - earlier mail'));
});

test('the citation payload exposes latest and previous to the UI', () => {
  const { toCitationPayload } = require('./services/aiService');
  const [s] = toCitationPayload([{
    _id: '656f00000000000000000003',
    title: 'Shipping Policy',
    source: 'google_docs',
    decision: 'Decision C - no Friday shipping',
    decisionHistory: [
      { text: 'Decision A - ship on Fridays', decidedAt: 't1', fromTitle: '' },
      { text: 'Decision B - ship on Wednesdays', decidedAt: 't2', fromTitle: '' },
    ],
  }], [4]);
  assert.strictEqual(s.ref, 4);
  assert.strictEqual(s.decision, 'Decision C - no Friday shipping');
  assert.strictEqual(s.previousDecision, 'Decision B - ship on Wednesdays');
  assert.strictEqual(s.decisionChangedAt, 't2');
  assert.strictEqual(s.decisionVersion, 3, 'version = history entries + current');
});

test('a document with no history reports no previous decision', () => {
  const { toCitationPayload } = require('./services/aiService');
  const [s] = toCitationPayload([{
    _id: '656f00000000000000000004',
    title: 'Fresh doc',
    source: 'slack',
    decision: 'Ship it',
    decisionHistory: [],
  }]);
  assert.strictEqual(s.previousDecision, null);
  assert.strictEqual(s.decisionVersion, 1);
});

test('an unscoped latest-decision question is recognized as a temporal lookup', () => {
  const { isLatestDecisionQuestion } = require('./routes/ask');
  assert.strictEqual(
    isLatestDecisionQuestion('what is the latest decision, and what was the immediately previous decision?'),
    true
  );
  assert.strictEqual(isLatestDecisionQuestion('What was the most recent resolution?'), true);
  assert.strictEqual(isLatestDecisionQuestion('What is the current decision?'), true);
  assert.strictEqual(isLatestDecisionQuestion('What decision did we make about leave?'), false);
});

/* ──────────────────────────────────────────────────────────
   Scheduler
   ────────────────────────────────────────────────────────── */
console.log('\nscheduler · backoff');

test('a failing source backs off instead of retrying every tick', async () => {
  const scheduler = require('./services/scheduler');
  let calls = 0;
  const failing = () => {
    calls += 1;
    return Promise.reject(new Error('boom'));
  };
  // Register a source, then drive ticks manually.
  scheduler.addSource('__smoke_failing', failing, { isAvailable: () => true });
  await scheduler.runOnce();
  await scheduler.runOnce();
  await scheduler.runOnce();
  assert.strictEqual(calls, 1, `expected backoff to suppress retries, got ${calls} calls`);
});

/* ────────────────────────────────────────────────────────── */
run();
