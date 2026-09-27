import { useState, useEffect } from 'react';
import { RefreshCw, Clock, Tag, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../api';

const SOURCE_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Gmail', value: 'gmail' },
  { label: 'Slack', value: 'slack' },
  { label: 'Docs', value: 'google_docs' },
  { label: 'Transcript', value: 'transcript' },
  { label: 'Manual', value: 'manual' },
];

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
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  const fetchDocs = async () => {
    setLoading(true);
    try {
      const data = await api.getDocuments(filter, 50);
      setDocuments(data.documents || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocs();
  }, [filter]);

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
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button className="btn btn-secondary btn-icon" onClick={fetchDocs} aria-label="Refresh documents">
              <RefreshCw size={16} className={loading ? 'spin' : ''} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="page-body">
        {loading ? (
          <div className="doc-list">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton" style={{ height: 104 }} />
            ))}
          </div>
        ) : documents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">📭</div>
            <h3>No documents found</h3>
            <p>Try changing your filter or ingest more data.</p>
          </div>
        ) : (
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
                  onClick={() => toggleDoc(doc._id)}
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

                      {/* Tags */}
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

                  {/* EXPANDED CONTENT AREA */}
                  {isExpanded && (
                    <div className="doc-expand">
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

                          <div className="doc-panel-label">Raw Source</div>
                          <div className="doc-raw">{doc.rawContent}</div>
                        </div>
                      </div>

                      {/* Full Tags List */}
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
        )}
      </div>
    </>
  );
}
