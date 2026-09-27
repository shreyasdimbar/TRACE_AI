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
  const [stats, setStats] = useState({ total: 0, gmail: 0, slack: 0, docs: 0, transcript: 0, manual: 0 });
  const [recentDocs, setRecentDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const allData = await api.getDocuments('', 20);
        const docs = allData.documents || [];
        setStats({
          total: docs.length,
          gmail: docs.filter(d => d.source === 'gmail').length,
          slack: docs.filter(d => d.source === 'slack').length,
          docs: docs.filter(d => d.source === 'google_docs').length,
          transcript: docs.filter(d => d.source === 'transcript').length,
          manual: docs.filter(d => d.source === 'manual').length,
        });
        setRecentDocs(docs.slice(0, 8)); // Grab up to 8 recent docs for activity
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const getSourceDetails = (source) => {
    switch (source) {
      case 'gmail': return { icon: <Mail size={14} />, color: 'var(--gmail)', label: 'Gmail' };
      case 'slack': return { icon: <Hash size={14} />, color: 'var(--slack)', label: 'Slack' };
      case 'google_docs': return { icon: <FileText size={14} />, color: 'var(--docs)', label: 'Docs' };
      default: return { icon: <FileText size={14} />, color: 'var(--text-secondary)', label: 'Upload' };
    }
  };

  const calculateBreakdown = () => {
    if (stats.total === 0) return [];
    return [
      { label: 'Gmail', val: stats.gmail, color: 'var(--gmail)', width: `${(stats.gmail / stats.total) * 100}%` },
      { label: 'Slack', val: stats.slack, color: 'var(--slack)', width: `${(stats.slack / stats.total) * 100}%` },
      {
        label: 'Documents',
        val: stats.docs + stats.transcript + stats.manual,
        color: 'var(--docs)',
        width: `${((stats.docs + stats.transcript + stats.manual) / stats.total) * 100}%`,
      },
    ].filter(item => item.val > 0);
  };

  const breakdownData = calculateBreakdown();
  const manualTotal = stats.docs + stats.transcript + stats.manual;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Overview</div>
        </div>
        <div className="page-head-actions">
          <div className="status-indicator">
            <div className="status-dot" aria-hidden="true" />
            <span>API Connected</span>
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
            <div className="stat-label">Total Documents</div>
            <div className="stat-value">{loading ? '—' : stats.total}</div>
            <div className="stat-meta">
              <span className="live-badge">↑ Live</span>
            </div>
          </div>

          <div className="stat-card" style={{ '--stat-accent': SOURCE_ACCENT.gmail }}>
            <div className="stat-label">Gmail Ingested</div>
            <div className="stat-value">{loading ? '—' : stats.gmail}</div>
            <div className="stat-meta">Emails processed</div>
          </div>

          <div className="stat-card" style={{ '--stat-accent': SOURCE_ACCENT.slack }}>
            <div className="stat-label">Slack Messages</div>
            <div className="stat-value">{loading ? '—' : stats.slack}</div>
            <div className="stat-meta">Channels monitored</div>
          </div>

          <div className="stat-card" style={{ '--stat-accent': SOURCE_ACCENT.google_docs }}>
            <div className="stat-label">Manual Docs</div>
            <div className="stat-value">{loading ? '—' : manualTotal}</div>
            <div className="stat-meta">Documents &amp; meetings</div>
          </div>
        </div>

        <div className="split-2">
          {/* ─── RECENT ACTIVITY ─── */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Recent Activity</span>
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
              ) : recentDocs.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon" aria-hidden="true">📝</div>
                  <h3>No recent activity</h3>
                  <p>Inbound documents and messages will appear here.</p>
                </div>
              ) : (
                <div className="activity-list">
                  {recentDocs.map((doc) => {
                    const src = getSourceDetails(doc.source);
                    return (
                      <div
                        key={doc._id}
                        className="activity-item"
                        role="button"
                        tabIndex={0}
                        onClick={() => setPage('feed')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setPage('feed');
                          }
                        }}
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
                              {new Date(doc.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                        <ArrowRight size={14} color="var(--text-muted)" aria-hidden="true" />
                      </div>
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
                <span className="card-title">Source Breakdown</span>
              </div>
              <div className="card-body">
                {breakdownData.length === 0 ? (
                  <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No data yet</span>
                ) : (
                  <div className="split-stack" style={{ gap: 16 }}>
                    {/* The Bar */}
                    <div className="breakdown-bar" role="presentation">
                      {breakdownData.map((b, i) => (
                        <div
                          key={i}
                          className="breakdown-seg"
                          style={{ width: b.width, background: b.color }}
                        />
                      ))}
                    </div>
                    {/* Legend */}
                    <div className="breakdown-legend">
                      {breakdownData.map((b, i) => (
                        <div key={i}>
                          <span className="breakdown-swatch" style={{ background: b.color }} aria-hidden="true" />
                          {b.label} <span className="breakdown-count">{b.val}</span>
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
                <span className="card-title">Quick Actions</span>
              </div>
              <div className="card-body">
                <div className="action-list">
                  <button className="action-btn" onClick={() => setPage('ask')}>
                    <MessageSquare size={16} aria-hidden="true" />
                    <span style={{ flex: 1, textAlign: 'left' }}>Ask a question</span>
                  </button>
                  <button className="action-btn" onClick={() => setPage('ingest')}>
                    <Upload size={16} aria-hidden="true" />
                    <span style={{ flex: 1, textAlign: 'left' }}>Upload document</span>
                  </button>
                  <button className="action-btn" onClick={() => setPage('ingest')}>
                    <Mail size={16} aria-hidden="true" />
                    <span style={{ flex: 1, textAlign: 'left' }}>Connect Gmail</span>
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
