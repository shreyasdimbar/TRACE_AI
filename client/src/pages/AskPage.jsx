import { useState, useRef, useEffect } from 'react';
import { Send, AlertTriangle, Clock, Lock } from 'lucide-react';
import { api } from '../api';
import { getSession } from '../session';
import { loadMessages, saveMessages } from '../chatStore';

const SUGGESTIONS = [
  'What decisions were made recently?',
  'Summarize the latest emails',
  'What is the team working on?',
  'Any action items from Slack?',
];

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
  const bottomRef = useRef(null);

  // Mirror every change to storage. The account id is read lazily rather than
  // closed over, so it is correct even though the session settles on boot
  // independently of this component.
  useEffect(() => {
    saveMessages(getSession()?.user?.id, messages);
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleAsk = async (question) => {
    const q = question || input.trim();
    if (!q || loading) return;

    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setInput('');
    setLoading(true);

    try {
      const data = await api.ask(q);
      setMessages((prev) => [
        ...prev,
        { role: 'ai', content: data.answer, sources: data.sources || [], grounded: data.grounded, degraded: data.degraded },
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  return (
    <div className="chat-container">
      {messages.length === 0 ? (
        <div className="chat-empty">
          <div className="chat-empty-icon" aria-hidden="true">⚡</div>
          <h3>Ask Trace.AI anything</h3>
          <p>
            Query your organizational knowledge base. I search across Gmail,
            Slack, docs, and transcripts to find answers with full source
            citations.
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
                  <p>{msg.content}</p>
                  {msg.grounded === false && (
                    <div className="chat-grounded-flag">
                      This answer was not grounded in the indexed sources.
                    </div>
                  )}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="chat-sources">
                      <div className="chat-sources-title">Sources</div>
                      <div className="chat-source-list">
                        {msg.sources.map((s, j) => (
                          <div key={j} className="chat-source-item">
                            <span className="chat-source-ref">{s.ref}</span>
                            <span className={`source-badge ${s.source}`}>{s.source}</span>
                            <span>{s.title}</span>
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
                        ))}
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
          <div ref={bottomRef} />
        </div>
      )}

      <div className="chat-input-area">
        <div className="chat-input-wrapper">
          <input
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your organization…"
            disabled={loading}
            id="ask-input"
            aria-label="Ask a question about your organization"
          />
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
  );
}
