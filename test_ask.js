/** Offline regression tests for archive query construction, ranking and context. */

require('dotenv').config();
const assert = require('assert');
const retrieval = require('./services/retrieval');
const ask = require('./routes/ask');
const ai = require('./services/aiService');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const doc = (id, values = {}) => ({
  _id: id,
  source: 'manual',
  title: `Document ${id}`,
  rawContent: '',
  ...values,
});

test('keeps a self-contained question focused', () => {
  const question = 'Who approved Project Phoenix launch budget?';
  assert.strictEqual(retrieval.buildRetrievalQuery(question, [
    { role: 'user', content: 'Summarize the Q3 hiring plan.' },
  ]), question);
  const standalone = 'What is the latest policy?';
  assert.strictEqual(retrieval.buildRetrievalQuery(standalone, [
    { role: 'user', content: 'Summarize the Q3 hiring plan.' },
  ]), standalone);
});

test('expands a short follow-up with the previous user question', () => {
  const query = retrieval.buildRetrievalQuery('What was the deadline?', [
    { role: 'user', content: 'Summarize the Phoenix launch plan.' },
  ]);
  assert.match(query, /Phoenix launch plan/i);
  assert.match(query, /deadline/i);
});

test('searches both the literal follow-up and its history-resolved form', () => {
  const queries = retrieval.buildRetrievalQueries('What was the deadline?', [
    { role: 'user', content: 'Summarize the Phoenix launch plan.' },
  ]);
  assert.strictEqual(queries.length, 2);
  assert.match(queries[0], /deadline/i);
  assert.doesNotMatch(queries[0], /Phoenix/i);
  assert.match(queries[1], /Phoenix/i);
});

test('resolves plural follow-ups from assistant text as search hints, not evidence', () => {
  const history = [
    { role: 'user', content: 'What projects is our company working on and who are the clients?' },
    { role: 'assistant', content: 'Based on the archive records, the company is working on the following projects:\n\nNovaCart E-commerce Platform\nClient: NovaTech Solutions [6], [8]\nAI Inventory & Demand Forecasting Platform\nClient: GreenMart Retail [3], [7]' },
  ];
  const query = retrieval.buildRetrievalQuery('updated of both in last month', history);
  assert.match(query, /NovaCart/i);
  assert.match(query, /GreenMart/i);
  assert.match(query, /updated of both in last month/i);
  assert.doesNotMatch(query, /\[6\]|\[8\]|\[3\]|\[7\]/);
  assert.deepStrictEqual(retrieval.getPriorAssistantSearchHints(history), [
    'NovaCart E-commerce Platform',
    'NovaTech Solutions',
    'AI Inventory & Demand Forecasting Platform',
    'GreenMart Retail',
  ]);
  assert.deepStrictEqual(retrieval.getPriorUserQuestions(history, 1), [
    'What projects is our company working on and who are the clients?',
  ]);
  assert.strictEqual(retrieval.isContextualFollowUp('updated of both in last month'), true);
});

test('entity hints match the named project or client, not generic words', () => {
  const hints = [
    'NovaCart E-commerce Platform',
    'NovaTech Solutions',
    'AI Inventory & Demand Forecasting Platform',
    'GreenMart Retail',
  ];
  const novaCartDoc = { title: 'Batch 3', summary: 'NovaCart deployment scheduled for Tuesday.' };
  const novaTechDoc = { title: 'Slack #social - TRACE', summary: 'NovaTech status review.' };
  const greenMartDoc = {
    title: 'Project Kickoff — AI Inventory & Demand Forecasting Platform',
    summary: 'Initiation of the AI Inventory & Demand Forecasting Platform project for GreenMart Retail.',
  };
  const newsletter = {
    title: 'Muse vs. Dots vs. Grok Bot: Read This Before You Choose',
    summary: 'An update from the AI Action Letter author on AI agents in production.',
  };
  const roadmap = {
    title: 'The Free 8-Week Roadmap to Become a $1M+ AI Engineer',
    summary: 'An AI career roadmap for engineers.',
  };

  assert.strictEqual(retrieval.documentMatchesEntity(novaCartDoc, hints[0]), true);
  assert.strictEqual(retrieval.documentMatchesEntity(novaTechDoc, hints[1]), true);
  assert.strictEqual(retrieval.documentMatchesEntity(greenMartDoc, hints[2]), true);
  assert.strictEqual(retrieval.documentMatchesEntity(greenMartDoc, hints[3]), true);
  assert.strictEqual(retrieval.documentMatchesEntity(newsletter, hints[0]), false);
  assert.strictEqual(retrieval.documentMatchesEntity(newsletter, hints[2]), false);
  assert.strictEqual(retrieval.documentMatchesEntity(roadmap, hints[2]), false);
  assert.deepStrictEqual(
    retrieval.filterByEntityHints([novaCartDoc, newsletter, roadmap], hints),
    [novaCartDoc]
  );
  // Never drop the whole candidate set just because the entity filter is empty.
  assert.deepStrictEqual(retrieval.filterByEntityHints([newsletter], hints), [newsletter]);
});

test('does not add assistant search hints to a self-contained question', () => {
  const question = 'Who approved the NovaCart release?';
  assert.strictEqual(retrieval.buildRetrievalQuery(question, [
    { role: 'assistant', content: 'GreenMart Retail inventory platform.' },
  ]), question);
});

test('last month resolves to the previous calendar month and filters dated evidence', () => {
  const window = retrieval.getDateWindow('updates from last month', new Date('2026-11-01T12:00:00Z'));
  assert.strictEqual(window.start.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.strictEqual(window.end.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.strictEqual(retrieval.isWithinDateWindow({ metadata: { date: '2026-10-15T11:00:00Z' } }, window), true);
  assert.strictEqual(retrieval.isWithinDateWindow({ metadata: { date: 'Mon, 28 Sep 2026 22:32:12 +0530' } }, window), false);
  assert.strictEqual(retrieval.isWithinDateWindow({ title: 'undated' }, window), false);
});

test('"prev of that month" resolves against the month the conversation discussed', () => {
  const history = [
    { role: 'user', content: 'what projects is our company working on and who are the clients' },
    { role: 'assistant', content: 'NovaCart E-commerce Platform\nClient: NovaTech Solutions\nAI Inventory & Demand Forecasting Platform\nClient: GreenMart Retail' },
    { role: 'user', content: 'updated of both in last month' },
    { role: 'assistant', content: 'There is no evidence dated within the last month (September 2026) in the archive sources.\n\nNovaCart\n\nPayment callback fix: Reviewed; the confirmation page' },
  ];
  const now = new Date('2026-11-01T12:00:00Z');
  assert.strictEqual(retrieval.isContextualFollowUp('prev of that month'), true);
  const window = retrieval.getDateWindow('prev of that month', now, history);
  assert.strictEqual(window.start.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.strictEqual(window.end.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.match(retrieval.describeDateWindow(window), /September 2026/);
});

test('an explicit month name is honoured without a year', () => {
  const window = retrieval.getDateWindow('what happened in September', new Date('2026-11-01T12:00:00Z'));
  assert.strictEqual(window.start.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.strictEqual(window.end.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.strictEqual(retrieval.getDateWindow('may I ask a question', new Date('2026-11-01T12:00:00Z')), null);
});

test('relative multi-month windows resolve from today', () => {
  const window = retrieval.getDateWindow('updated of both in last 6 months', new Date('2026-11-01T12:00:00Z'));
  assert.strictEqual(window.start.toISOString(), '2026-05-01T00:00:00.000Z');
  assert.strictEqual(window.end.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.strictEqual(retrieval.getDateWindow('updates in past 3 months', new Date('2026-11-01T12:00:00Z')).start.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('asksForAllSources recognises full-sweep follow-ups', () => {
  assert.strictEqual(retrieval.asksForAllSources('updated of both in last 6 months , everything means every email every doc and every tile'), true);
  assert.strictEqual(retrieval.asksForAllSources('updates on both'), false);
  assert.strictEqual(retrieval.asksForAllSources('what is the latest decision?'), false);
});

test('entity hints survive a later answer that no longer lists clients', () => {
  const history = [
    { role: 'user', content: 'what projects is our company working on and who are the clients' },
    { role: 'assistant', content: 'Based on the archive records:\n\nNovaCart E-commerce Platform\nClient: NovaTech Solutions [6], [8]\nAI Inventory & Demand Forecasting Platform\nClient: GreenMart Retail [3], [7]' },
    { role: 'user', content: 'updated of both in last month' },
    { role: 'assistant', content: 'There is no evidence dated within the last month (September 2026) in the archive sources.\n\nNovaCart\n\nPayment callback fix: Reviewed; the confirmation page' },
  ];
  const hints = retrieval.getPriorAssistantSearchHints(history);
  assert.ok(hints.includes('NovaCart E-commerce Platform'));
  assert.ok(hints.includes('NovaTech Solutions'));
  assert.ok(hints.includes('AI Inventory & Demand Forecasting Platform'));
  assert.ok(hints.includes('GreenMart Retail'));
  assert.ok(!hints.some((hint) => /no evidence|payment callback|below are/i.test(hint)));
});

test('resolves pronouns for archive follow-ups', () => {
  const query = retrieval.buildRetrievalQuery('What did they decide about it?', [
    { role: 'user', content: 'Find the decision on the Atlas migration.' },
  ]);
  assert.match(query, /Atlas migration/i);
});

test('uses the latest prior user question and ignores assistant content', () => {
  const history = [
    { role: 'user', content: 'Summarize Project Atlas.' },
    { role: 'assistant', content: 'The assistant guessed Project Orion.' },
    { role: 'user', content: 'hello' },
  ];
  const prior = retrieval.getPriorUserQuestions(history, 1);
  assert.deepStrictEqual(prior, ['Summarize Project Atlas.']);
  const query = retrieval.buildRetrievalQuery('Why?', history);
  assert.match(query, /Project Atlas/i);
  assert.doesNotMatch(query, /Project Orion/i);
});

test('does not invent a retrieval referent from assistant-only or greeting history', () => {
  const question = 'What is the policy?';
  assert.strictEqual(retrieval.buildRetrievalQuery(question, [
    { role: 'assistant', content: 'Maybe it is about travel.' },
    { role: 'user', content: 'hi there' },
  ]), question);
});

test('does not append unrelated history to a self-contained question that uses a pronoun', () => {
  const question = 'Is it important to index all project sources?';
  assert.strictEqual(retrieval.buildRetrievalQuery(question, [
    { role: 'user', content: 'Summarize the Q3 hiring plan.' },
  ]), question);
});

test('normalizes search terms and retains short identifiers', () => {
  assert.deepStrictEqual(
    retrieval.extractSearchTerms('What was the Q3 budget for cafés?'),
    ['q3', 'budget', 'cafes']
  );
});

test('lexical ranking favors title evidence over body-only matches', () => {
  const titleMatch = doc('title', { title: 'Phoenix migration decision', rawContent: 'General notes.' });
  const bodyMatch = doc('body', { title: 'General notes', rawContent: 'Phoenix migration decision.' });
  assert.ok(retrieval.scoreLexicalDocument('Phoenix migration decision', titleMatch) >
    retrieval.scoreLexicalDocument('Phoenix migration decision', bodyMatch));
});

test('lexical fallback searches structured decisions and source metadata', () => {
  const structured = doc('structured', {
    title: 'Weekly sync',
    rawContent: 'Unrelated body.',
    decision: 'Approve Atlas migration in July',
    metadata: { channel: 'platform-ops', sender: 'Mira' },
  });
  assert.ok(retrieval.scoreLexicalDocument('Atlas migration', structured) > 0);
  assert.ok(retrieval.scoreLexicalDocument('platform ops', structured) > 0);
  assert.ok(retrieval.scoreLexicalDocument('manual', doc('source', { title: 'Weekly sync', source: 'manual' })) > 0);
});

test('lexical ranking can find superseded decisions and their origin', () => {
  const historical = doc('history', {
    title: 'Weekly sync',
    rawContent: 'Unrelated body.',
    decision: 'Keep the current release date',
    decisionHistory: [{ text: 'Move the Phoenix launch to June', fromTitle: 'Launch planning' }],
  });
  assert.ok(retrieval.scoreLexicalDocument('Phoenix June', historical) > 0);
  assert.ok(retrieval.scoreLexicalDocument('planning', historical) > 0);
});

test('lexical scorer rejects documents with no matching evidence', () => {
  assert.strictEqual(retrieval.scoreLexicalDocument('Phoenix launch', doc('x', {
    title: 'Hiring plan', rawContent: 'Quarterly staffing notes.',
  })), 0);
});

test('lexical scoring avoids substring-only false matches', () => {
  assert.strictEqual(retrieval.scoreLexicalDocument('art', doc('x', {
    title: 'Quarterly party notes', rawContent: 'Planning and refreshments.',
  })), 0);
});

test('semantic index text contains structured evidence plus body content', () => {
  const text = retrieval.buildIndexText({
    source: 'slack',
    title: 'Phoenix launch',
    summary: 'Launch moved to June.',
    decision: 'Ship after security review.',
    reasoning: 'The review prevents a risky release.',
    tags: ['launch', 'security'],
    metadata: { sender: 'Mira Shah', channel: 'release-planning', date: '2026-08-12' },
    rawContent: 'Please hold the release until the checklist is complete.',
  });
  for (const evidence of ['Title: Phoenix launch', 'Summary: Launch moved to June.', 'Decision: Ship after security review.',
    'Reasoning:', 'Tags: launch, security', 'From: Mira Shah', 'Channel: release-planning', 'Content:', 'checklist is complete']) {
    assert.ok(text.includes(evidence), `semantic index payload missing ${evidence}`);
  }
});

test('semantic index text carries superseded decision terms', () => {
  const text = retrieval.buildIndexText({
    title: 'Phoenix launch',
    rawContent: 'Latest update.',
    decisionHistory: [{ text: 'Move launch to June', fromTitle: 'Launch planning' }],
  });
  assert.match(text, /Prior decisions: Move launch to June/);
});

test('semantic index text is bounded and retains body context from both ends', () => {
  const body = `${'opening evidence '.repeat(100)}${'middle '.repeat(100)}${'closing evidence '.repeat(100)}`;
  const text = retrieval.buildIndexText({ title: 'Long report', rawContent: body }, 1200);
  assert.ok(text.length <= 1200);
  assert.match(text, /opening evidence/);
  assert.match(text, /closing evidence/);
  assert.match(text, /middle omitted/);
});

test('rank fusion preserves vector order when it is the only signal', () => {
  const vectors = [doc('v1'), doc('v2'), doc('v3')];
  assert.deepStrictEqual(retrieval.rankDocuments(vectors, [], 3).map((d) => d._id), ['v1', 'v2', 'v3']);
});

test('rank fusion promotes a result independently supported by both signals', () => {
  const vectors = [doc('a'), doc('b'), doc('c')];
  const keywords = [doc('b'), doc('d')];
  assert.strictEqual(retrieval.rankDocuments(vectors, keywords, 4)[0]._id, 'b');
});

test('rank fusion de-duplicates IDs and enforces the requested cap', () => {
  const ranked = retrieval.rankDocuments(
    [doc('same'), doc('same', { title: 'Duplicate' }), doc('other')],
    [doc('same'), doc('third')],
    2
  );
  assert.strictEqual(ranked.length, 2);
  assert.strictEqual(new Set(ranked.map((d) => d._id)).size, 2);
});

test('latest-decision routing distinguishes scoped topics from global lookup', () => {
  assert.strictEqual(ask.getLatestDecisionTopic('What is the latest decision about Project Phoenix?'), 'phoenix');
  assert.strictEqual(ask.isGlobalLatestDecisionQuestion('What is the latest decision?'), true);
  assert.strictEqual(ask.isGlobalLatestDecisionQuestion('What is the latest decision and the immediately previous decision?'), true);
  assert.strictEqual(ask.isGlobalLatestDecisionQuestion('What is the latest decision about Phoenix?'), false);
  assert.strictEqual(ask.getLatestDecisionTopic('What is the newest decision for Project Phoenix?'), 'phoenix');
});

test('latest-email questions use the named topic rather than broad recency search', () => {
  const question = 'Elaborate the latest email regarding FinEdge Services';
  assert.strictEqual(ask.isLatestEmailQuestion(question), true);
  assert.strictEqual(ask.getLatestEmailTopic(question), 'FinEdge Services');
  assert.strictEqual(ask.isLatestEmailQuestion('Elaborate the latest update about FinEdge Services'), false);
  assert.strictEqual(ask.getLatestEmailTopic('What is the latest email?'), '');
  assert.match(ask.noEvidenceMessage(question), /indexed Gmail email/i);
});

test('context keeps retrieval rank instead of sorting by raw document length', () => {
  const blocks = ai.buildContext([
    doc('best', { title: 'Best match', rawContent: 'best evidence'.repeat(5) }),
    doc('empty', { title: 'Empty source', rawContent: '' }),
    doc('long', { title: 'Long weaker match', rawContent: 'weaker evidence '.repeat(400) }),
  ], 2400);
  assert.strictEqual(blocks[0].doc._id, 'best');
  assert.strictEqual(blocks[1].doc._id, 'long');
  assert.match(blocks[0].text, /^\[1\]/);
  assert.match(blocks[1].text, /^\[2\]/);
});

test('context includes structured metadata and shares its budget across ranked sources', () => {
  const documents = [1, 2, 3].map((index) => doc(`source-${index}`, {
    title: `Phoenix planning ${index}`,
    summary: `Summary ${index}`,
    decision: `Decision ${index}`,
    reasoning: `Reasoning ${index}`,
    tags: ['phoenix', 'planning'],
    metadata: { sender: `owner-${index}`, channel: 'launch-planning', date: '2026-08-12' },
    rawContent: `Evidence for source ${index}. `.repeat(300),
  }));
  const blocks = ai.buildContext(documents, 1800);
  assert.strictEqual(blocks.length, 3);
  assert.match(blocks[0].text, /From: owner-1/);
  assert.match(blocks[0].text, /Channel: launch-planning/);
  assert.match(blocks[0].text, /Decision: Decision 1/);
  assert.match(blocks[0].text, /Extracted reasoning: Reasoning 1/);
  assert.ok(blocks.every((block) => block.text.length > 250), 'each source should retain useful evidence');
  const assembledContext = blocks.map((block) => block.text).join('\n\n');
  assert.ok(assembledContext.length <= 1800, 'assembled context exceeded its budget');
  assert.deepStrictEqual([...ai.citedBlockRefs('Supported by [1] and [2, 3].')], [1, 2, 3]);
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${name}\n      ${error.stack || error.message}`);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} Ask retrieval tests passed.`);
  process.exitCode = failures ? 1 : 0;
})();
