import { useState, useRef, useEffect } from 'react';
import { Send, AlertTriangle, Clock, ExternalLink, Lock, Sparkles } from 'lucide-react';
import { api } from '../api';
import { getSession } from '../session';
import { loadMessages, saveMessages } from '../chatStore';
import { parseAnswerBlocks } from '../answerFormat';

const SUGGESTIONS = [
  'What decisions were made recently?',
  'Summarize the latest project updates',
  'What should the team follow up on?',
  'Draft an email requesting a project update',
];

const WELCOME_PROMPTS = [
  'What should we uncover today?',
  'Let’s connect the dots.',
  'What are we looking into?',
  'Ready to find the signal in your workspace?',
  'Ask away—we’ll find the thread.',
  'What can I help you move forward?',
];

function createWelcomeGreeting() {
  const hour = new Date().getHours();
  const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = getSession()?.user?.name?.trim().split(/\s+/)[0];
  const prompt = WELCOME_PROMPTS[Math.floor(Math.random() * WELCOME_PROMPTS.length)];

  return {
    salutation: firstName ? `${salutation}, ${firstName}` : salutation,
    prompt,
  };
}

const SIMPLE_GREETINGS = new Set([
  'hi', 'hello', 'hey', 'heya', 'howdy', 'yo', 'sup',
  'hi there', 'hello there', 'hey there',
  'hi trace', 'hello trace', 'hey trace',
  'hi trace ai', 'hello trace ai', 'hey trace ai',
  'good morning', 'good afternoon', 'good evening', 'good day',
  'how are you', 'how are you doing',
  "what's up", 'whats up', "how's it going", 'hows it going',
]);

function isSimpleGreeting(message) {
  const normalized = message
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return SIMPLE_GREETINGS.has(normalized) ||
    /^(?:hi|hello|hey|heya|howdy|yo|sup)(?: there)?(?: (?:hi|hello|hey|heya|howdy))*$/.test(normalized);
}

function createGreetingReply() {
  const hour = new Date().getHours();
  const period = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const firstName = getSession()?.user?.name?.trim().split(/\s+/)[0];
  const name = firstName ? `, ${firstName}` : '';
  const replies = {
    morning: [
      `Good morning${name}! Ready to uncover something useful?`,
      `Morning${name}—what would you like to explore in the workspace?`,
      `Good morning${name}. Ask away; let’s connect the dots.`,
    ],
    afternoon: [
      `Good afternoon${name}! What can I help you find?`,
      `Hey${name}, what are we looking into today?`,
      `Good afternoon${name}. Let’s find the signal in your workspace.`,
    ],
    evening: [
      `Good evening${name}! What can I help you wrap up?`,
      `Evening${name}—ready when you are. What’s on your mind?`,
      `Good evening${name}. Let’s track down a clear answer.`,
    ],
  };
  const choices = replies[period];

  return choices[Math.floor(Math.random() * choices.length)];
}

function renderInlineMarkdown(text, keyPrefix) {
  const parts = String(text || '').split(/(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function renderAnswer(content) {
  return parseAnswerBlocks(content).map((block, index) => {
    const key = `answer-${index}`;
    if (block.type === 'heading') {
      const Heading = block.level <= 2 ? 'h3' : 'h4';
      return <Heading key={key}>{renderInlineMarkdown(block.text, key)}</Heading>;
    }
    if (block.type === 'unordered-list' || block.type === 'ordered-list') {
      const List = block.type === 'ordered-list' ? 'ol' : 'ul';
      return (
        <List key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-${itemIndex}`)}</li>
          ))}
        </List>
      );
    }
    if (block.type === 'code') {
      return <pre key={key}><code>{block.text}</code></pre>;
    }
    return <p key={key}>{renderInlineMarkdown(block.text, key)}</p>;
  });
}

function safeSourceHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function sourceLabel(source) {
  const labels = {
    gmail: 'Gmail',
    google_docs: 'Google Docs',
    slack: 'Slack',
    transcript: 'Transcript',
    manual: 'Manual note',
  };
  return labels[source] || String(source || 'Source').replace(/[_-]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function formatSourceDate(value) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp);
}

/**
 * Turn a transport error into something a user can act on.
 *
 * The API returns a distinct code for each failure class, and they need
 * different responses from the user: a suspended AI key is an admin problem, a
 * dead backend is a local one, and a rejected question is neither. Collapsing
 * all of them into "make sure the backend is running" sends people to debug the
 * wrong thing.
 */
function describeError(err) {
  if (err?.code === 'NOT_CONFIGURED' || err?.status === 503) {
    return {
      kind: 'config',
      icon: <Lock size={15} aria-hidden="true" />,
      text: 'The AI provider is not configured or is not accepting requests. ' +
            'An administrator needs to check the API key and the AI_MODEL settings.',
    };
  }
  if (err?.code === 'RATE_LIMITED' || err?.status === 429) {
    const wait = err.retryAfterSeconds ? ` Try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).` : '';
    return { kind: 'rate', icon: <Clock size={15} aria-hidden="true" />, text: `Too many requests.${wait}` };
  }
  if (err?.status === 401) {
    return { kind: 'auth', icon: <Lock size={15} aria-hidden="true" />, text: 'Your session has expired. Sign in again to continue.' };
  }
  if (err?.status === 400) {
    return { kind: 'input', icon: <AlertTriangle size={15} aria-hidden="true" />, text: err.message || 'That question was rejected.' };
  }
  if (err?.status === 502 || err?.code?.startsWith?.('UPSTREAM')) {
    return {
      kind: 'upstream',
      icon: <AlertTriangle size={15} aria-hidden="true" />,
      text: 'The AI provider rejected the request. This is usually an invalid or suspended API key ' +
            'rather than a problem with your question.',
    };
  }
  if (err?.status >= 500 || err?.status === undefined) {
    return {
      kind: 'offline',
      icon: <AlertTriangle size={15} aria-hidden="true" />,
      text: 'Cannot reach the Trace.AI API. Check that the server is running on port 5000.',
    };
  }
  return { kind: 'generic', icon: <AlertTriangle size={15} aria-hidden="true" />, text: err?.message || 'Something went wrong.' };
}

export default function AskPage() {
  // Restored on mount so navigating to another tab and back does not wipe the
  // conversation. Keyed by account, so it is per-user as well as per-tab.
  const [messages, setMessages] = useState(() => loadMessages(getSession()?.user?.id));
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // Explicit answer mode chosen by the user in the chat UI. The backend treats
  // this as authoritative when it is 'general' or 'archive'; absent/invalid
  // values fall back to automatic intent routing.
  const [askMode, setAskMode] = useState('archive');
  const [welcomeGreeting] = useState(createWelcomeGreeting);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Mirror every change to storage. The account id is read lazily rather than
  // closed over, so it is correct even though the session settles on boot
  // independently of this component.
  useEffect(() => {
    saveMessages(getSession()?.user?.id, messages);
  }, [messages]);

  useEffect(() => {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, [messages]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [input]);

  const handleAsk = async (question) => {
    const q = question || input.trim();
    if (!q || loading) return;

    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setInput('');
    setLoading(true);

    try {
      if (isSimpleGreeting(q)) {
        setMessages((prev) => [
          ...prev,
          { role: 'ai', content: createGreetingReply(), sources: [] },
        ]);
        return;
      }

      // Send only the recent visible conversation, so ordinary chat and email
      // revisions can handle follow-ups such as "make it warmer". The API
      // ignores this history for archive-grounded questions.
      const history = messages
        .filter((msg) => msg.role === 'user' || msg.role === 'ai')
        .slice(-8)
        .map((msg) => ({ role: msg.role === 'ai' ? 'assistant' : 'user', content: msg.content }));
      const data = await api.ask(q, history, askMode);
      setMessages((prev) => [
        ...prev,
        { role: 'ai', content: data.answer, sources: data.sources || [], grounded: data.grounded, degraded: data.degraded, mode: data.mode },
      ]);
    } catch (err) {
      const info = describeError(err);
      setMessages((prev) => [
        ...prev,
        { role: 'error', kind: info.kind, icon: info.icon, content: info.text, detail: err?.message },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleAsk();
    }
  };

  return (
    <div className="ask-page-shell">
      <div className="page-header ask-page-header">
        <div>
          <h1 className="page-title">Ask Anything</h1>
          <div className="page-subtitle">Find answers across your organization’s shared knowledge.</div>
        </div>
        <div className="ask-workspace-badge">
          <Sparkles size={15} aria-hidden="true" />
          <span>Workspace assistant</span>
        </div>
      </div>

      <div className="chat-container">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true"><Sparkles size={23} /></div>
            <div className="chat-empty-kicker">{welcomeGreeting.salutation}</div>
            <h3>{welcomeGreeting.prompt}</h3>
            <p>
              Chat naturally, draft or polish emails, or search Gmail, Slack, Docs,
              and transcripts for organization-specific answers with citations.
            </p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="btn btn-secondary" onClick={() => handleAsk(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-messages" role="log" aria-live="polite">
            {messages.map((msg, i) => {
              if (msg.role === 'error') {
                return (
                  <div key={i} className="chat-msg error">
                    <div className={`chat-notice ${msg.kind}`} role="alert">
                      <span className="chat-notice-icon">{msg.icon}</span>
                      <div>
                        <p>{msg.content}</p>
                        {msg.detail && <code className="chat-notice-detail">{msg.detail}</code>}
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className={`chat-msg ${msg.role}`}>
                  <div className="chat-bubble">
                    {msg.role === 'ai'
                      ? <div className="chat-answer">{renderAnswer(msg.content)}</div>
                      : <p>{msg.content}</p>}
                    {msg.grounded === false && (
                      <div className="chat-grounded-flag">
                        This answer was not grounded in the indexed sources.
                      </div>
                    )}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="chat-sources">
                        <div className="chat-sources-heading">
                          <div className="chat-sources-title">Sources</div>
                          <span className="chat-sources-count">{msg.sources.length}</span>
                        </div>
                        <div className="chat-source-list">
                          {msg.sources.map((s, j) => {
                            const href = safeSourceHref(s.link);
                            return (
                              <div key={`${s.ref}-${s.docId || j}`} className="chat-source-item">
                                <span className="chat-source-ref" aria-label={`Citation ${s.ref}`}>[{s.ref}]</span>
                                <div className="chat-source-main">
                                  {href ? (
                                    <a className="chat-source-title" href={href} target="_blank" rel="noreferrer">
                                      {s.title || 'Untitled source'}
                                      <ExternalLink size={13} aria-hidden="true" />
                                    </a>
                                  ) : (
                                    <span className="chat-source-title">{s.title || 'Untitled source'}</span>
                                  )}
                                  <div className="chat-source-meta">
                                    <span className="source-badge" data-source={s.source}>{sourceLabel(s.source)}</span>
                                    {s.date && <span className="chat-source-date">{formatSourceDate(s.date)}</span>}
                                  </div>
                                  {s.previousDecision && (
                                    <div className="chat-source-decision">
                                      <span className="chat-source-decision-latest">
                                        Latest: {s.decision && s.decision !== 'No decision' ? s.decision : 'no decision'}
                                      </span>
                                      <span className="chat-source-decision-prev">
                                        Previously: {s.previousDecision}
                                        {s.decisionFromTitle ? ` · from ${s.decisionFromTitle}` : ''}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {loading && (
              <div className="chat-msg ai">
                <div className="chat-bubble thinking">
                  <div className="spinner" />
                  <span className="thinking-label">Thinking…</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} className="chat-bottom-anchor" />
          </div>
        )}

        <div className="chat-input-area">
          <div className="chat-mode-bar" role="group" aria-label="Answer mode" aria-describedby="chat-mode-hint">
            <div className="chat-mode-controls">
              <span className="chat-mode-label">Mode</span>
              <div className="chat-mode-switch">
                <button
                  type="button"
                  className={`chat-mode-btn ${askMode === 'archive' ? 'active' : ''}`}
                  onClick={() => setAskMode('archive')}
                  aria-pressed={askMode === 'archive'}
                  title="Use indexed workspace sources and citations"
                >
                  Context
                </button>
                <button
                  type="button"
                  className={`chat-mode-btn ${askMode === 'general' ? 'active' : ''}`}
                  onClick={() => setAskMode('general')}
                  aria-pressed={askMode === 'general'}
                  title="Chat without limiting answers to indexed sources"
                >
                  General
                </button>
              </div>
            </div>
            <p id="chat-mode-hint" className="chat-composer-note sr-only">
              {askMode === 'archive'
                ? 'Answers use indexed workspace sources and include citations when available.'
                : 'General chat is not limited to indexed workspace sources.'}
            </p>
          </div>
          <div className="chat-input-wrapper">
            <textarea
              ref={inputRef}
              className="chat-input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={askMode === 'archive' ? 'Ask a question about your organization…' : 'Chat, brainstorm, or draft an email…'}
              disabled={loading}
              id="ask-input"
              aria-label={`${askMode === 'archive' ? 'Ask a question about your organization' : 'Chat or draft an email'}. Press Enter to send; Shift+Enter for a new line.`}
              aria-describedby="chat-input-shortcut-hint"
            />
            <span id="chat-input-shortcut-hint" className="sr-only">
              Press Enter to send. Press Shift+Enter to add a new line.
            </span>
            <button
              className="btn btn-primary btn-icon"
              onClick={() => handleAsk()}
              disabled={!input.trim() || loading}
              id="ask-submit"
              aria-label="Send question"
            >
              <Send size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
