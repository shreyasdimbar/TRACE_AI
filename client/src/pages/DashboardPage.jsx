import { useState, useEffect } from 'react';
import { Plus, Mail, Hash, FileText, Upload, MessageSquare, ArrowRight } from 'lucide-react';
import { api } from '../api';

const SOURCE_ACCENT = {
  gmail: 'var(--gmail)',
  slack: 'var(--slack)',
  google_docs: 'var(--docs)',
  transcript: 'var(--transcript)',
  manual: 'var(--text-tertiary)',
};

export default function DashboardPage({ setPage }) {
  const [stats, setStats] = useState({ total: null, bySource: {} });
  const [recentDocs, setRecentDocs] = useState([]);
  const [recentDocsError, setRecentDocsError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [apiState, setApiState] = useState('checking');

  useEffect(() => {
    async function load() {
      const [statsResult, docsResult, healthResult] = await Promise.allSettled([
        api.getDocumentStats(),
        api.getDocuments('', 8, false),
        api.health(),
      ]);

      if (statsResult.status === 'fulfilled') {
        setStats({
          total: statsResult.value.total ?? 0,
          bySource: statsResult.value.bySource || {},
        });
      } else {
        console.error(statsResult.reason);
      }

      if (docsResult.status === 'fulfilled') {
        setRecentDocs(docsResult.value.documents || []);
        setRecentDocsError(false);
      } else {
        setRecentDocsError(true);
        console.error(docsResult.reason);
      }

      setApiState(
        healthResult.status === 'fulfilled' && healthResult.value.status === 'ok'
          ? 'connected'
          : 'degraded'
      );
      if (healthResult.status === 'rejected') console.error(healthResult.reason);
      setLoading(false);
    }
    load();
  }, []);

  const getSourceDetails = (source) => {
    switch (source) {
      case 'gmail': return { icon: <Mail size={14} />, color: 'var(--gmail)', label: 'Gmail' };
      case 'slack': return { icon: <Hash size={14} />, color: 'var(--slack)', label: 'Slack' };
      case 'google_docs': return { icon: <FileText size={14} />, color: 'var(--docs)', label: 'Docs' };
      case 'transcript': return { icon: <FileText size={14} />, color: 'var(--transcript)', label: 'Transcript' };
      default: return { icon: <FileText size={14} />, color: 'var(--text-secondary)', label: 'Manual' };
    }
  };

  const sourceRows = [
    { key: 'gmail', keys: ['gmail'], label: 'Gmail', color: SOURCE_ACCENT.gmail },
    { key: 'slack', keys: ['slack'], label: 'Slack', color: SOURCE_ACCENT.slack },
    { key: 'google_docs', keys: ['google_docs'], label: 'Google Docs', color: SOURCE_ACCENT.google_docs },
    { key: 'transcript', keys: ['transcript'], label: 'Transcripts', color: SOURCE_ACCENT.transcript },
    { key: 'manual', keys: ['manual', 'note', 'document'], label: 'Manual notes', color: SOURCE_ACCENT.manual },
  ].map((row) => ({
    ...row,
    count: row.keys.reduce((sum, key) => sum + (stats.bySource[key]?.count || 0), 0),
  }));
  const knownSourceCount = sourceRows.reduce((sum, row) => sum + row.count, 0);
  if (stats.total !== null && stats.total > knownSourceCount) {
    sourceRows.push({ key: 'other', label: 'Other', color: SOURCE_ACCENT.manual, count: stats.total - knownSourceCount });
  }
  const breakdownData = sourceRows.filter((row) => row.count > 0);
  const documentNotesCount = sourceRows
    .filter((row) => ['google_docs', 'transcript', 'manual'].includes(row.key))
    .reduce((sum, row) => sum + row.count, 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <div className="page-subtitle">Your team’s searchable knowledge, brought together.</div>
        </div>
        <div className="page-head-actions">
          <div className={`status-indicator is-${apiState}`} aria-live="polite">
            <div className="status-dot" aria-hidden="true" />
            <span>
              {apiState === 'checking' ? 'Checking API' :
                apiState === 'connected' ? 'API available' : 'API or database issue'}
            </span>
          </div>
          <button className="btn btn-primary" onClick={() => setPage('ingest')}>
            <Plus size={16} aria-hidden="true" /> Ingest
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* ─── STATS ─── */}
        <div className="stats-grid">
          <div className="stat-card" style={{ '--stat-accent': 'var(--a-400)' }}>
            <div className="stat-label">Indexed documents</div>
            <div className="stat-value">{loading || stats.total === null ? '—' : stats.total}</div>
            <div className="stat-meta">
              Complete corpus count
            </div>
          </div>

          <div className="stat-card" style={{ '--stat-accent': SOURCE_ACCENT.gmail }}>
            <div className="stat-label">Gmail messages</div>
            <div className="stat-value">{loading || stats.total === null ? '—' : sourceRows[0].count}</div>
            <div className="stat-meta">Indexed email content</div>
          </div>

          <div className="stat-card" style={{ '--stat-accent': SOURCE_ACCENT.slack }}>
            <div className="stat-label">Slack messages</div>
            <div className="stat-value">{loading || stats.total === null ? '—' : sourceRows[1].count}</div>
            <div className="stat-meta">Indexed channel messages</div>
          </div>

          <div className="stat-card" style={{ '--stat-accent': SOURCE_ACCENT.google_docs }}>
            <div className="stat-label">Docs &amp; notes</div>
            <div className="stat-value">{loading || stats.total === null ? '—' : documentNotesCount}</div>
            <div className="stat-meta">Drive, transcripts, and manual</div>
          </div>
        </div>

        <div className="split-2">
          {/* ─── RECENT ACTIVITY ─── */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Recently indexed</span>
              <button className="btn btn-ghost" onClick={() => setPage('feed')}>
                View all
              </button>
            </div>
            <div className="card-body is-flush">
              {loading ? (
                <div className="scan-state">
                  <div className="spinner" />
                  <span>Loading activity…</span>
                </div>
              ) : recentDocsError ? (
                <div className="empty-state">
                  <div className="empty-state-icon" aria-hidden="true"><FileText size={24} /></div>
                  <h3>Activity unavailable</h3>
                  <p>Recent activity could not be loaded. Try again in a moment.</p>
                </div>
              ) : recentDocs.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon" aria-hidden="true"><FileText size={24} /></div>
                  <h3>No recent activity</h3>
                  <p>Inbound documents and messages will appear here.</p>
                </div>
              ) : (
                <div className="activity-list">
                  {recentDocs.map((doc) => {
                    const src = getSourceDetails(doc.source);
                    return (
                      <button
                        type="button"
                        key={doc._id}
                        className="activity-item"
                        onClick={() => setPage('feed')}
                      >
                        <div className="activity-glyph" style={{ color: src.color }} aria-hidden="true">
                          {src.icon}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="activity-title">{doc.title}</div>
                          <div className="activity-meta">
                            <span style={{ color: src.color, fontWeight: 600 }}>{src.label}</span>
                            <span className="dot" aria-hidden="true">•</span>
                            <span>
                              {new Date(doc.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                              {' · '}
                              {new Date(doc.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                        <ArrowRight size={14} color="var(--text-muted)" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ─── RIGHT CHUNKS ─── */}
          <div className="split-stack">
            {/* Source Breakdown */}
            <div className="card">
              <div className="card-header">
                  <h2 className="card-title">Knowledge by source</h2>
              </div>
              <div className="card-body">
                {breakdownData.length === 0 ? (
                  <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No data yet</span>
                ) : (
                  <div className="split-stack" style={{ gap: 16 }}>
                    {/* The Bar */}
                    <div
                      className="breakdown-bar"
                      role="img"
                      aria-label={`Source distribution across ${stats.total} indexed documents`}
                    >
                      {breakdownData.map((b) => (
                        <div
                          key={b.key}
                          className="breakdown-seg"
                          style={{ width: `${(b.count / stats.total) * 100}%`, background: b.color }}
                        />
                      ))}
                    </div>
                    {/* Legend */}
                    <div className="breakdown-legend">
                      {sourceRows.map((b) => (
                        <div key={b.key}>
                          <span className="breakdown-swatch" style={{ background: b.color }} aria-hidden="true" />
                          {b.label} <span className="breakdown-count">{b.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Quick Actions */}
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Quick actions</h2>
              </div>
              <div className="card-body">
                <div className="action-list">
                  <button className="action-btn" onClick={() => setPage('ask')}>
                    <MessageSquare size={16} aria-hidden="true" />
                    <span style={{ flex: 1, textAlign: 'left' }}>Ask a question</span>
                  </button>
                  <button className="action-btn" onClick={() => setPage('ingest')}>
                    <Upload size={16} aria-hidden="true" />
                    <span style={{ flex: 1, textAlign: 'left' }}>Add text or transcript</span>
                  </button>
                  <button className="action-btn" onClick={() => setPage('ingest')}>
                    <Mail size={16} aria-hidden="true" />
                    <span style={{ flex: 1, textAlign: 'left' }}>Manage sources</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
