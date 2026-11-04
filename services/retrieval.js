/** Pure helpers shared by archive retrieval and its offline regression tests. */

const STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'before', 'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'hers', 'him', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'our', 'ours', 'please', 'she', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours',
]);

const EXPLICIT_FOLLOWUP = /\b(?:what about|how about|and then|same|former|latter|above|earlier|previous|before|again|both|either|each of them|all of them|those two|these two)\b/i;
const ASSISTANT_REFERENCE_FOLLOWUP = /\b(?:both|either|former|latter|each of them|all of them|those two|these two|both of those|both projects|each project|their updates?|that month|this month|same month|prev(?:ious)?\s+(?:of|to)\s+(?:that|this)\s+month)\b/i;
const REFERENTIAL_PRONOUN = /\b(?:it|its|that|this|these|those|they|them|their|he|she|there)\b/i;
const BARE_LOOKUP = /^(?:why|when|where|who|how much|how many|deadline|due date|date|decision|budget|owner|amount|timeline|reason|status|result|outcome|cost|price)[?.!\s]*$/i;
const SMALLTALK = /^(?:(?:hi+|hello+|hey+|hiya|yo|howdy|sup)(?:\s+(?:there|ya|you|team|everyone|folks|chat|friend|mate|how\s+(?:are\s+you|is\s+it\s+going|goes)|howdy|what'?s\s+up))?|thanks?|thank\s+you|thx|ok(?:ay)?|cool|nice|great|ping|test|what'?s\s+up)[\s!.?]*$/i;
const VECTOR_INDEX_VERSION = 2;
const VECTOR_TEXT_MAX_CHARS = 7900;

// Words that appear in almost any project description. They must never be the
// reason a document is treated as belonging to an entity named in a follow-up.
const GENERIC_ENTITY_TOKENS = new Set([
  'ai', 'artificial', 'intelligence', 'ml', 'platform', 'platforms', 'solution', 'solutions',
  'service', 'services', 'system', 'systems', 'app', 'apps', 'application', 'applications',
  'product', 'products', 'project', 'projects', 'client', 'clients', 'customer', 'customers',
  'company', 'companies', 'team', 'teams', 'data', 'cloud', 'software', 'tech', 'technology',
  'technologies', 'digital', 'business', 'engineering', 'retail', 'ecommerce', 'commerce',
  'update', 'updates', 'work', 'workflow', 'workflows', 'automation', 'agent', 'agents',
  'new', 'next', 'first', 'initial', 'main', 'core', 'general', 'internal',
]);

function tokenize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

function extractSearchTerms(text, limit = 16) {
  const terms = [];
  const seen = new Set();
  for (const token of tokenize(text)) {
    if (token.length < 2 || STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
    if (terms.length >= limit) break;
  }
  return terms;
}

function getPriorUserQuestions(history, limit = 2) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => message?.role === 'user' && typeof message.content === 'string')
    .map((message) => message.content.trim().slice(0, 500))
    .filter((content) => content && !SMALLTALK.test(content))
    .slice(-limit);
}

/** Prior assistant text can resolve a reference, but is never archive evidence. */
function getPriorAssistantAnswers(history, limit = 1) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => ['assistant', 'ai'].includes(message?.role) && typeof message.content === 'string')
    .map((message) => String(message.content)
      .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1'))
      .filter((line) => line &&
        !/^(?:based on (?:the )?(?:archive|indexed) records?|according to (?:the )?(?:archive|indexed) sources?)/i.test(line) &&
        !/^#{1,6}\s*(?:sources|current projects)\s*$/i.test(line))
      .join('\n')
      .slice(0, 1200))
    .filter(Boolean)
    .slice(-Math.max(0, limit));
}

const ENTITY_HEADINGS = new Set([
  'sources', 'source', 'current projects', 'projects', 'project updates', 'updates',
  'summary', 'status', 'milestones', 'current scope', 'key updates', 'overview',
  'notes', 'next steps', 'details', 'highlights',
]);
const NON_ENTITY_LINES = new Set([
  'sure', 'yes', 'no', 'okay', 'ok', 'thanks', 'thank you', 'note', 'important',
  'here', 'below', 'above', 'none', 'n/a', 'unknown',
]);

function cleanAnswerLine(line) {
  return String(line || '')
    .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\s,;]+$/g, '')
    .trim();
}

/**
 * Pull entity names out of one assistant answer.
 *
 * The reliable shape is a project line followed by a "Client:" line, which is
 * what the project-overview answer produces. Short standalone headings are a
 * fallback for plain lists. Ordinary prose and truncated fragments are ignored
 * so they cannot become bogus retrieval filters.
 */
function extractEntityHintsFromAnswer(answer) {
  const rawLines = String(answer || '').split(/\r?\n/);
  const lines = rawLines.map(cleanAnswerLine);
  const hints = [];
  let sawClientLine = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const client = line.match(/^(?:client|customer)\s*:\s*(.+)$/i);
    if (client) {
      sawClientLine = true;
      const value = client[1].trim();
      if (value && extractSearchTerms(value, 12).length) hints.push(value);
      continue;
    }
    const next = lines[i + 1] || '';
    if (/^(?:client|customer)\s*:/i.test(next)) {
      if (extractSearchTerms(line, 12).length) hints.push(line);
    }
  }

  if (sawClientLine) return [...new Set(hints)];

  // Fallback: a short line standing alone between blank lines or in a bullet
  // list, e.g. a project name. Requires a capital letter and no sentence
  // punctuation so ordinary prose is not mistaken for an entity.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.split(/\s+/).length > 4) continue;
    if (/[.:;!?]$/.test(line)) continue;
    if (!/[A-Z]/.test(line)) continue;
    const lower = line.toLowerCase();
    if (ENTITY_HEADINGS.has(lower) || NON_ENTITY_LINES.has(lower)) continue;
    const isBullet = /^\s*[-*+]\s+/.test(rawLines[i] || '');
    const blankBefore = i === 0 || !lines[i - 1];
    const blankAfter = i === lines.length - 1 || !lines[i + 1];
    if (!isBullet && (!blankBefore || !blankAfter)) continue;
    hints.push(line);
  }
  return [...new Set(hints)];
}

/**
 * Entity hints for a referential follow-up.
 *
 * The immediately preceding answer is often a partial answer with no entity
 * list (for example "no updates in that month"), so scan the last few answers
 * and merge their entity names. Hints are only ever search filters; retrieved
 * documents remain the sole evidence.
 */
function getPriorAssistantSearchHints(history, limit = 8) {
  if (!Array.isArray(history)) return [];
  const answers = history
    .filter((message) => ['assistant', 'ai'].includes(message?.role) && typeof message.content === 'string')
    .map((message) => message.content)
    .slice(-3);
  const hints = [];
  for (const answer of answers) hints.push(...extractEntityHintsFromAnswer(answer));
  return [...new Set(hints)].slice(0, Math.max(0, limit));
}

function isContextualFollowUp(question) {
  return ASSISTANT_REFERENCE_FOLLOWUP.test(String(question || '').trim());
}

/**
 * Build the literal strings that identify an entity named in a prior answer.
 * A hint such as "NovaCart E-commerce Platform" yields the full normalized
 * phrase plus its brand token ("novacart"); generic words like "platform" or
 * "ai" never qualify on their own.
 */
function buildEntityMatchers(hint) {
  const tokens = tokenize(hint);
  const matchers = new Set();
  if (tokens.length >= 2) matchers.add(tokens.join(' '));

  // Brand names carry an internal capital (NovaCart, NovaTech, GreenMart).
  for (const raw of String(hint).match(/[A-Za-z][A-Za-z0-9]*/g) || []) {
    if (!/[a-z][A-Z]/.test(raw)) continue;
    const lower = raw.toLowerCase();
    if (lower.length >= 3 && !GENERIC_ENTITY_TOKENS.has(lower)) matchers.add(lower);
  }

  // Fall back to the first specific word so single-word entities still work.
  if (![...matchers].some((m) => !m.includes(' '))) {
    const specific = tokens.find(
      (token) => token.length >= 4 && !STOP_WORDS.has(token) && !GENERIC_ENTITY_TOKENS.has(token)
    );
    if (specific) matchers.add(specific);
  }
  return [...matchers];
}

function getDocumentEntityText(doc = {}) {
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value) parts.push(value);
  };
  push(doc.title);
  push(doc.summary);
  push(doc.decision);
  push(doc.reasoning);
  push(doc.rawContent);
  for (const tag of Array.isArray(doc.tags) ? doc.tags : []) push(tag);
  for (const item of Array.isArray(doc.decisionHistory) ? doc.decisionHistory : []) {
    push(item?.text);
    push(item?.summary);
    push(item?.fromTitle);
  }
  const metadata = doc.metadata || {};
  for (const key of ['sender', 'to', 'from', 'channel', 'channelId', 'participants', 'subject', 'labels']) {
    const value = metadata[key];
    if (Array.isArray(value)) value.forEach(push);
    else push(value);
  }
  return ` ${tokenize(parts.join('\n')).join(' ')} `;
}

/** True when the document itself names the entity, not just a generic word. */
function documentMatchesEntity(doc, hint) {
  const text = getDocumentEntityText(doc);
  if (text.trim().length === 0) return false;
  return buildEntityMatchers(hint).some((matcher) => text.includes(` ${matcher} `));
}

/** Keep only documents tied to at least one entity named in the prior answer. */
function filterByEntityHints(docs, hints) {
  const usableHints = (Array.isArray(hints) ? hints : []).filter(Boolean);
  if (!usableHints.length) return docs;
  const matched = docs.filter((doc) => usableHints.some((hint) => documentMatchesEntity(doc, hint)));
  return matched.length ? matched : docs;
}

/**
 * Attach the last user question only when the current turn is referential or
 * too underspecified to retrieve on its own. Assistant answers are deliberately
 * excluded: they are not archive evidence and must not contaminate grounding.
 */
function buildRetrievalQuery(question, history = []) {
  const current = String(question || '').trim();
  if (!current) return '';
  const [previous] = getPriorUserQuestions(history, 1).slice(-1);
  const currentTerms = extractSearchTerms(current);
  const assistantReferenceFollowUp = isContextualFollowUp(current);
  const userReferenceFollowUp = EXPLICIT_FOLLOWUP.test(current) ||
    (REFERENTIAL_PRONOUN.test(current) && currentTerms.length <= 3) ||
    /\bwhat (?:is|was) (?:the )?(?:deadline|due date|decision|budget|owner|amount|timeline|reason|status|result|outcome|next step|cost|price)\b/i.test(current) ||
    BARE_LOOKUP.test(current);
  if (!assistantReferenceFollowUp && !userReferenceFollowUp) return current;
  const [assistantHint] = assistantReferenceFollowUp ? getPriorAssistantAnswers(history, 1) : [];
  const userHint = previous && previous.toLowerCase() !== current.toLowerCase() ? previous : '';
  if (!assistantHint && !userHint) return current;

  // Put the assistant's entity names first so exact keyword fallback can find
  // them even on short follow-ups. This text is a search hint only; the answer
  // still has to be grounded in retrieved archive documents.
  return [
    assistantHint || null,
    `Current follow-up: ${current}`,
    userHint ? `Related to the previous user question: ${userHint}` : null,
  ].filter(Boolean).join('\n');
}

/** Keep both the literal question and its resolved follow-up form searchable. */
function buildRetrievalQueries(question, history = []) {
  const current = String(question || '').trim();
  if (!current) return [];
  const expanded = buildRetrievalQuery(current, history);
  return expanded === current ? [current] : [current, expanded];
}

const MONTH_INDEX = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};
const MONTH_PATTERN = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b(?:\s+(\d{4}))?/i;
const MONTH_BEFORE_ANCHOR = /\b(?:prev(?:ious)?|last|prior)\s+(?:of\s+|to\s+)?(?:that|this)\s+month\b/i;
const MONTH_BEFORE_NOW = /\b(?:last|previous|prev|prior)\s+month\b/i;
const THAT_MONTH = /\b(?:that|same)\s+month\b/i;
const THIS_MONTH = /\bthis\s+month\b/i;

function monthWindow(year, month) {
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

function shiftMonth(reference, offset) {
  const date = new Date(Date.UTC(reference.year, reference.month + offset, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

/**
 * Parse a month the user named explicitly. A bare "may" is ignored unless it
 * carries a year, because it is far more often a modal verb than a month.
 */
function parseExplicitMonth(text) {
  const match = String(text || '').match(MONTH_PATTERN);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const year = match[2] ? Number(match[2]) : null;
  if (name === 'may' && !year) return null;
  if (!year) {
    const prefix = String(text).slice(0, match.index).toLowerCase();
    const suffix = String(text).slice(match.index + match[0].length).toLowerCase();
    const hasTimeContext =
      /\b(?:in|during|for|from|since|of|by|until|through)\s*$/.test(prefix) ||
      /^\s*(?:updates?|summary|news|status|report|decisions?|work|progress|activity)\b/.test(suffix);
    if (!hasTimeContext) return null;
  }
  return { year, month: MONTH_INDEX[name] };
}

/** The month a prior question was asking about, used as the "that month" anchor. */
function getAnchorMonth(history, nowMonth) {
  if (!Array.isArray(history)) return nowMonth;
  const priorQuestions = getPriorUserQuestions(history, 3).reverse();
  for (const question of priorQuestions) {
    const explicit = parseExplicitMonth(question);
    if (explicit) {
      return { year: explicit.year ?? nowMonth.year, month: explicit.month };
    }
    if (MONTH_BEFORE_ANCHOR.test(question) || MONTH_BEFORE_NOW.test(question)) {
      return shiftMonth(nowMonth, -1);
    }
    if (THAT_MONTH.test(question) || THIS_MONTH.test(question)) return nowMonth;
  }
  return nowMonth;
}

/**
 * Resolve relative time expressions before ranking archive evidence.
 *
 * "last month" is measured from today. "previous of that month" is measured
 * from the month the conversation was already discussing, which is recovered
 * from the prior user question — never from the assistant's prose, which may
 * itself have mislabelled the month.
 */
function getDateWindow(question, now = new Date(), history = []) {
  const text = String(question || '');
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) return null;
  const nowMonth = { year: current.getUTCFullYear(), month: current.getUTCMonth() };

  const explicit = parseExplicitMonth(text);
  if (explicit) {
    return monthWindow(explicit.year ?? nowMonth.year, explicit.month);
  }

  if (MONTH_BEFORE_ANCHOR.test(text)) {
    const anchor = getAnchorMonth(history, nowMonth);
    const target = shiftMonth(anchor, -1);
    return monthWindow(target.year, target.month);
  }
  if (MONTH_BEFORE_NOW.test(text)) {
    const target = shiftMonth(nowMonth, -1);
    return monthWindow(target.year, target.month);
  }
  if (THAT_MONTH.test(text)) {
    const anchor = getAnchorMonth(history, nowMonth);
    return monthWindow(anchor.year, anchor.month);
  }
  if (THIS_MONTH.test(text)) {
    return monthWindow(nowMonth.year, nowMonth.month);
  }
  const relativeWindow = text.match(/\b(?:last|previous|past)\s+(\d{1,2})\s+(months?|weeks?|days?)\b/i);
  if (relativeWindow) {
    const amount = Number(relativeWindow[1]);
    const unit = relativeWindow[2].toLowerCase();
    const nowMs = current.getTime();
    if (unit.startsWith('month')) {
      // Exclusive end = first day of the current month, consistent with the
      // calendar-month windows used elsewhere.
      const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1));
      return { start: new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - amount, 1)), end };
    }
    const durationMs = unit.startsWith('week')
      ? amount * 7 * 24 * 60 * 60 * 1000
      : amount * 24 * 60 * 60 * 1000;
    return { start: new Date(nowMs - durationMs), end: new Date(nowMs) };
  }
  if (/\b(?:past\s+month|last\s+30\s+days)\b/i.test(text)) {
    return { start: new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000), end: current };
  }
  return null;
}

/** True when the user asked for every source, e.g. "all emails and docs". */
function asksForAllSources(question) {
  return /\b(?:everything|every|all sources|all updates|all emails|all docs|all of them|all sources and updates)\b/i.test(String(question || ''));
}

/** Human-readable window used in the answer prompt. */
function describeDateWindow(window) {
  if (!window) return '';
  const start = new Date(window.start);
  const endInclusive = new Date(new Date(window.end).getTime() - 24 * 60 * 60 * 1000);
  const format = (date) => date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const monthLabel = start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${format(start)} to ${format(endInclusive)} (${monthLabel})`;
}

function documentDate(doc = {}) {
  // Prefer the document's own source-derived timestamps (createdAt/updatedAt
  // are stamped from provider metadata / content-mentioned dates at ingest
  // time) and fall back to raw metadata for legacy / minimal fixtures.
  const value = doc.createdAt || doc.updatedAt || doc.metadata?.date || doc.metadata?.modifiedTime || doc.metadata?.createdTime;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function isWithinDateWindow(doc, window) {
  if (!window) return true;
  const date = documentDate(doc);
  return Boolean(date && date >= window.start && date < window.end);
}

/**
 * Build a bounded semantic-index payload from the evidence fields users ask
 * about. The old index embedded rawContent only, so titles, extracted decisions,
 * summaries and Slack/Gmail attribution were invisible to vector retrieval.
 * Structured facts stay first; long bodies retain both their opening and tail.
 */
function buildIndexText(doc = {}, maxChars = VECTOR_TEXT_MAX_CHARS) {
  const limit = Math.max(256, Math.min(VECTOR_TEXT_MAX_CHARS, Number(maxChars) || VECTOR_TEXT_MAX_CHARS));
  const metadata = doc.metadata || {};
  const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const tags = Array.isArray(doc.tags) ? doc.tags.filter(Boolean).join(', ') : '';
  const participants = Array.isArray(metadata.participants) ? metadata.participants.join(', ') : '';
  const date = metadata.date || metadata.modifiedTime || metadata.createdTime;
  const header = [
    doc.title ? `Title: ${clean(doc.title, 250)}` : null,
    doc.source ? `Source: ${clean(doc.source, 40)}` : null,
    doc.summary ? `Summary: ${clean(doc.summary, 600)}` : null,
    doc.decision && doc.decision !== 'No decision' ? `Decision: ${clean(doc.decision, 600)}` : null,
    doc.reasoning ? `Reasoning: ${clean(doc.reasoning, 400)}` : null,
    Array.isArray(doc.decisionHistory) && doc.decisionHistory.length
      ? `Prior decisions: ${doc.decisionHistory.slice(-5).map((entry) => clean(entry?.text, 220)).filter(Boolean).join(' | ')}`
      : null,
    tags ? `Tags: ${clean(tags, 200)}` : null,
    metadata.sender ? `From: ${clean(metadata.sender, 180)}` : null,
    metadata.to ? `To: ${clean(metadata.to, 180)}` : null,
    metadata.channel ? `Channel: ${clean(metadata.channel, 120)}` : null,
    participants ? `Participants: ${clean(participants, 220)}` : null,
    date ? `Date: ${clean(date, 60)}` : null,
  ].filter(Boolean).join('\n');
  const body = String(doc.rawContent ?? '').trim();
  const separator = header && body ? '\n' : '';
  const bodyStart = `${header}${separator}${body ? 'Content:\n' : ''}`;
  const bodyBudget = Math.max(0, limit - bodyStart.length);

  if (!body || body.length <= bodyBudget) return `${bodyStart}${body}`.slice(0, limit);
  const marker = '\n[…middle omitted…]\n';
  if (bodyBudget <= marker.length + 2) return `${bodyStart}${body.slice(0, bodyBudget)}`.slice(0, limit);
  const contentBudget = bodyBudget - marker.length;
  const headLength = Math.ceil(contentBudget * 0.72);
  const tailLength = contentBudget - headLength;
  return `${bodyStart}${body.slice(0, headLength)}${marker}${tailLength ? body.slice(-tailLength) : ''}`.slice(0, limit);
}

/**
 * Reciprocal-rank fusion for independent vector and lexical result lists.
 * A document supported by both signals rises naturally without comparing
 * incompatible cosine distances and Mongo text scores.
 */
function rankDocuments(vectorDocs = [], keywordDocs = [], limit = 6, options = {}) {
  const vectorWeight = Number(options.vectorWeight) > 0 ? Number(options.vectorWeight) : 1;
  const keywordWeight = Number(options.keywordWeight) > 0 ? Number(options.keywordWeight) : 1.15;
  const byId = new Map();
  let sequence = 0;

  const addRanked = (docs, source, weight) => {
    for (let index = 0; index < docs.length; index += 1) {
      const doc = docs[index];
      if (!doc || doc._id == null) continue;
      const id = String(doc._id);
      let entry = byId.get(id);
      if (!entry) {
        entry = { doc, score: 0, vectorRank: Infinity, keywordRank: Infinity, sequence: sequence++ };
        byId.set(id, entry);
      }
      entry.score += weight / (60 + index + 1);
      if (source === 'vector') entry.vectorRank = Math.min(entry.vectorRank, index);
      else entry.keywordRank = Math.min(entry.keywordRank, index);
    }
  };

  addRanked(vectorDocs, 'vector', vectorWeight);
  // Exact lexical evidence is particularly useful for names, numbers and dates.
  addRanked(keywordDocs, 'keyword', keywordWeight);

  return [...byId.values()]
    .sort((a, b) =>
      b.score - a.score ||
      Math.min(a.vectorRank, a.keywordRank) - Math.min(b.vectorRank, b.keywordRank) ||
      a.sequence - b.sequence
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.doc);
}

const LEXICAL_FIELDS = [
  ['title', 5],
  ['source', 3],
  ['decision', 5],
  ['decisionHistory.text', 4],
  ['decisionHistory.summary', 2],
  ['decisionHistory.fromTitle', 3],
  ['summary', 4],
  ['tags', 3],
  ['reasoning', 2.5],
  ['metadata.channel', 2.5],
  ['metadata.sender', 2],
  ['metadata.to', 1.5],
  ['metadata.participants', 1.5],
  ['metadata.channelId', 1.5],
  ['metadata.messageId', 1],
  ['metadata.date', 1.5],
  ['metadata.threadId', 1.5],
  ['metadata.googleDocId', 1.5],
  ['metadata.link', 1],
  ['rawContent', 1],
];

function readField(doc, path) {
  let values = [doc];
  for (const key of path.split('.')) {
    values = values.flatMap((value) => {
      const next = value?.[key];
      return Array.isArray(next) ? next : next == null ? [] : [next];
    });
  }
  return values.length === 1 ? values[0] : values;
}

function fieldText(value) {
  return Array.isArray(value) ? value.join(' ') : String(value ?? '');
}

/** Deterministic fallback scorer; weights titles and structured facts highly. */
function scoreLexicalDocument(question, doc = {}, { includeBody = true } = {}) {
  const terms = extractSearchTerms(question);
  if (!terms.length || !doc) return 0;

  let weightedHits = 0;
  let totalWeight = 0;
  const matchedTerms = new Set();
  const fields = includeBody ? LEXICAL_FIELDS : LEXICAL_FIELDS.filter(([path]) => path !== 'rawContent');
  const fieldTokens = fields.map(([path]) =>
    new Set(tokenize(fieldText(readField(doc, path))))
  );
  for (const term of terms) {
    let bestWeight = 0;
    for (let index = 0; index < fields.length; index += 1) {
      const [, weight] = fields[index];
      if (fieldTokens[index].has(term)) bestWeight = Math.max(bestWeight, weight);
    }
    totalWeight += 5;
    if (bestWeight > 0) {
      weightedHits += bestWeight;
      matchedTerms.add(term);
    }
  }

  if (matchedTerms.size === 0) return 0;
  const coverage = matchedTerms.size / terms.length;
  const title = fieldText(doc.title).toLowerCase();
  const normalizedTitle = tokenize(title).join(' ');
  const normalizedQuery = terms.join(' ');
  const exactTitleBoost = normalizedQuery && normalizedTitle.includes(normalizedQuery) ? 5 : 0;
  return (weightedHits / totalWeight) * coverage + exactTitleBoost;
}

module.exports = {
  STOP_WORDS,
  tokenize,
  extractSearchTerms,
  getPriorUserQuestions,
  getPriorAssistantAnswers,
  getPriorAssistantSearchHints,
  isContextualFollowUp,
  buildEntityMatchers,
  documentMatchesEntity,
  filterByEntityHints,
  buildRetrievalQuery,
  buildRetrievalQueries,
  getDateWindow,
  describeDateWindow,
  asksForAllSources,
  documentDate,
  isWithinDateWindow,
  buildIndexText,
  VECTOR_INDEX_VERSION,
  VECTOR_TEXT_MAX_CHARS,
  rankDocuments,
  scoreLexicalDocument,
};
