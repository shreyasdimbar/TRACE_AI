import { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { api } from '../api';

const SUGGESTIONS = [
  'What decisions were made recently?',
  'Summarize the latest emails',
  'What is the team working on?',
  'Any action items from Slack?',
];

export default function AskPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

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
        { role: 'ai', content: data.answer, sources: data.sources || [] },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'ai', content: 'Something went wrong. Make sure the backend is running.', sources: [] },
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
          {messages.map((msg, i) => (
            <div key={i} className={`chat-msg ${msg.role}`}>
              <div className="chat-bubble">
                <p>{msg.content}</p>
                {msg.sources && msg.sources.length > 0 && (
                  <div className="chat-sources">
                    <div className="chat-sources-title">Sources</div>
                    <div className="chat-source-list">
                      {msg.sources.map((s, j) => (
                        <div key={j} className="chat-source-item">
                          <span className={`source-badge ${s.source}`}>{s.source}</span>
                          <span>{s.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
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
