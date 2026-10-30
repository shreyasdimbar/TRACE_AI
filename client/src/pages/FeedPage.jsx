import { useState, useEffect } from 'react';
import { RefreshCw, Clock, Tag, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, AlertTriangle, Lock } from 'lucide-react';
import { api } from '../api';

const SOURCE_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Gmail', value: 'gmail' },
  { label: 'Slack', value: 'slack' },
  { label: 'Docs', value: 'google_docs' },
  { label: 'Transcript', value: 'transcript' },
  { label: 'Manual', value: 'manual' },
];

const PAGE_SIZE = 20;

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function FeedPage() {
  const [documents, setDocuments] = useState([]);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const fetchDocs = async (targetPage = page) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getDocuments(filter, PAGE_SIZE, true, targetPage * PAGE_SIZE);
      setDocuments(data.documents || []);
      setTotal(data.total ?? 0);
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      // Without this the list renders "No documents found" for an API outage,
      // which reads as an empty corpus rather than a broken connection.
      setDocuments([]);
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocs(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, page]);

  // A new filter means a new result set, so return to the first page.
  const changeFilter = (value) => {
    setFilter(value);
    setPage(0);
    setSelected(null);
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastShown = Math.min(total, (page + 1) * PAGE_SIZE);

  const toggleDoc = (id) => setSelected((prev) => (prev === id ? null : id));

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Documents</div>
          <div className="page-subtitle">Structured knowledge extracted from your integrations</div>
        </div>
        <div className="page-head-actions">
          <div className="filter-bar">
            <div className="filter-group" role="group" aria-label="Filter by source">
              {SOURCE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  className={`filter-chip ${filter === f.value ? 'is-active' : ''}`}
                  aria-pressed={filter === f.value}
                  onClick={() => changeFilter(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button className="btn btn-secondary btn-icon" onClick={() => fetchDocs(page)} aria-label="Refresh documents">
              <RefreshCw size={16} className={loading ? 'spin' : ''} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="page-body">
        {error ? (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">
              {error.status === 401 || error.status === 403 ? <Lock size={26} /> : <AlertTriangle size={26} />}
            </div>
            <h3>{error.status === 401 ? 'Session expired' : 'Cannot reach the API'}</h3>
            <p>
              {error.status === 401
                ? 'Sign out and sign in again to load documents.'
                : 'The documents service did not respond. Check that the backend is running on port 5000.'}
            </p>
            {error.status !== 401 && error.status < 500 && <code className="empty-state-detail">{error.message}</code>}
          </div>
        ) : loading ? (
          <div className="doc-list">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton" style={{ height: 104 }} />
            ))}
          </div>
        ) : documents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">📭</div>
            <h3>No documents found</h3>
            <p>{filter ? 'No documents match this source. Try another filter.' : 'Ingest some data to get started.'}</p>
          </div>
        ) : (
          <>
            <div className="doc-list">
              {documents.map((doc) => {
                const isExpanded = selected === doc._id;

                return (
                  <div
                    key={doc._id}
                    className={`doc-card liquid-sweep ${isExpanded ? 'is-open' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => {
                      // A mouseup that ends a text selection still fires a `click`,
                      // which bubbled up here and closed the card mid-selection —
                      // before the user could copy the reasoning / source text.
                      const sel = window.getSelection();
                      const selectedText =
                        sel && !sel.isCollapsed ? sel.toString() : '';
                      if (selectedText.trim().length > 0) return;
                      toggleDoc(doc._id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleDoc(doc._id);
                      }
                    }}
                  >
                    <div className="doc-main">
                      <div className="doc-rail">
                        <span className={`source-badge ${doc.source}`}>{doc.source}</span>
                      </div>

                      <div className="doc-body">
                        <div className="doc-head">
                          <h3 className="doc-title">{doc.title}</h3>
                          <div className="doc-aside">
                            <span className="doc-clock">
                              <Clock size={12} aria-hidden="true" /> {timeAgo(doc.createdAt)}
                            </span>
                            {isExpanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
                          </div>
                        </div>

                        <div className="doc-summary">
                          {doc.summary || doc.rawContent?.substring(0, 200)}
                        </div>

                        {doc.tags && doc.tags.length > 0 && !isExpanded && (
                          <div className="doc-tags">
                            <span className="tag-label">
                              <Tag size={12} aria-hidden="true" />
                            </span>
                            {doc.tags.slice(0, 4).map((t, i) => (
                              <span key={i} className="doc-tag">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      /* `.doc-expand` is styled as a small inline-flex pill
                         button, so using it as this panel's wrapper gave the
                         whole expanded block a 999px border-radius and turned
                         its children into horizontal flex items — the giant
                         ellipse outline across the card. The panel gets its own
                         block-level class. */
                      <div className="doc-detail">
                        <div className="doc-split">
                          <div>
                            <div className="doc-panel-label">AI Reasoning</div>
                            <div className={`doc-insight ${doc.reasoning ? '' : 'is-empty'}`}>
                              {doc.reasoning || 'No extracted reasoning available.'}
                            </div>
                          </div>

                          <div>
                            {doc.decision && doc.decision !== 'No decision' && (
                              <div className="decision-note">
                                <div className="doc-panel-label">Decision</div>
                                {doc.decision}
                              </div>
                            )}

                            {Array.isArray(doc.decisionHistory) && doc.decisionHistory.length > 0 && (
                              <div className="decision-history">
                                <div className="doc-panel-label">Decision changed</div>
                                {(() => {
                                  const prev = doc.decisionHistory[doc.decisionHistory.length - 1];
                                  return (
                                    <>
                                      <div className="decision-history-latest">
                                        Latest: {doc.decision && doc.decision !== 'No decision' ? doc.decision : 'no decision'}
                                      </div>
                                      <div className="decision-history-prev">
                                        Previously: {prev.text}
                                        {prev.fromTitle ? ` · from ${prev.fromTitle}` : ''}
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>
                            )}

                            <div className="doc-panel-label">Raw Source</div>
                            <div className="doc-raw">{doc.rawContent}</div>
                          </div>
                        </div>

                        {doc.tags && doc.tags.length > 0 && (
                          <div className="doc-tagline">
                            <div className="doc-panel-label" style={{ width: '100%' }}>Index Tags</div>
                            <div className="doc-tags" style={{ marginTop: 0 }}>
                              {doc.tags.map((t, i) => (
                                <span key={i} className="doc-tag">#{t.replace(/\s+/g, '')}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {pageCount > 1 && (
              <nav className="pager" aria-label="Document pages">
                <span className="pager-status">
                  Showing <strong>{firstShown}</strong>–<strong>{lastShown}</strong> of <strong>{total}</strong>
                </span>
                <div className="pager-controls">
                  <button
                    className="btn btn-secondary btn-icon"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0 || loading}
                    aria-label="Previous page"
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <span className="pager-count">
                    Page {page + 1} of {pageCount}
                  </span>
                  <button
                    className="btn btn-secondary btn-icon"
                    onClick={() => setPage((p) => (hasMore ? p + 1 : p))}
                    disabled={!hasMore || loading}
                    aria-label="Next page"
                  >
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </nav>
            )}
          </>
        )}
      </div>
    </>
  );
}
