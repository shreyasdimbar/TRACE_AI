import { useState, useEffect } from 'react';
import { Mail, Hash, FileText, Mic, ArrowRight, X, Check, FolderOpen, RefreshCw, AlertCircle, Lock } from 'lucide-react';
import { api } from '../api';

export default function IngestPage() {
  const [modal, setModal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // Manual ingest form
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [source, setSource] = useState('manual');

  // Google Docs state
  const [driveFiles, setDriveFiles] = useState([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [connections, setConnections] = useState({ gmail: null, slack: null, docs: null });

  const refreshConnections = async () => {
    const [gmail, slack, docs] = await Promise.allSettled([
      api.getGmailStatus(),
      api.request('/api/slack/health'),
      api.getGDocsStatus(),
    ]);
    const nextConnections = {
      gmail: gmail.status === 'fulfilled' ? gmail.value : { unavailable: true },
      slack: slack.status === 'fulfilled' ? slack.value : { unavailable: true },
      docs: docs.status === 'fulfilled' ? docs.value : { unavailable: true },
    };
    setConnections(nextConnections);
    return nextConnections;
  };

  useEffect(() => {
    refreshConnections();
  }, []);

  useEffect(() => {
    if (!modal) return undefined;
    const dialog = document.querySelector('.modal-overlay [role="dialog"]');
    if (!dialog) return undefined;

    const previousFocus = document.activeElement;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = window.requestAnimationFrame(() => {
      (dialog.querySelector(focusableSelector) || dialog).focus();
    });

    const keepFocusInDialog = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModal(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll(focusableSelector)];
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', keepFocusInDialog);
    return () => {
      window.cancelAnimationFrame(focusFirst);
      document.removeEventListener('keydown', keepFocusInDialog);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [modal]);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleManualIngest = async () => {
    if (!title.trim() || !content.trim()) return;
    setLoading(true);
    try {
      const data = await api.ingest(source, title, content);
      showToast(`Ingested "${title}" — ${data.tags?.length || 0} tags extracted`);
      setTitle('');
      setContent('');
      setModal(null);
    } catch (err) {
      showToast('Ingestion failed. Check the backend.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGmailFetch = async () => {
    setLoading(true);
    try {
      const data = await api.fetchGmail(10);
      showToast(`Gmail: ${data.ingested_count || 0} new emails ingested`);
      setModal(null);
    } catch (err) {
      showToast('Gmail fetch failed. Ensure OAuth is connected.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSlackFetch = async (channelName) => {
    setLoading(true);
    try {
      const data = await api.fetchSlack(channelName, 10);
      showToast(`Slack #${channelName}: ${data.ingested_count || 0} new messages ingested`);
    } catch (err) {
      showToast('Slack fetch failed.', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Google Docs handlers
  const loadDriveFiles = async () => {
    setDriveLoading(true);
    setDriveError(false);
    try {
      const data = await api.listDriveDocs();
      setDriveFiles(data.files || []);
    } catch (err) {
      setDriveFiles([]);
      setDriveError(true);
      showToast('Could not list Drive files. Check the Google connection and folder settings.', 'error');
    } finally {
      setDriveLoading(false);
    }
  };

  const handleOpenGDocs = async () => {
    setModal('gdocs');
    setDriveFiles([]);
    setDriveError(false);
    setSyncResult(null);
    setDriveLoading(false);

    const status = connections.docs || (await refreshConnections()).docs;
    if (status?.connected && status?.driveFolderConfigured) {
      await loadDriveFiles();
    }
  };

  const refreshDriveStatus = async () => {
    const next = await refreshConnections();
    if (next.docs?.connected && next.docs?.driveFolderConfigured) {
      await loadDriveFiles();
    }
  };

  const handleSyncGDocs = async () => {
    setDriveLoading(true);
    setSyncResult(null);
    try {
      const data = await api.fetchDriveDocs();
      setSyncResult(data);
      showToast(`Google Docs: ${data.ingested_count || 0} new docs ingested`);
      // Re-fetch the list to update statuses
      const updated = await api.listDriveDocs();
      setDriveFiles(updated.files || []);
    } catch (err) {
      showToast('Drive sync failed. Check backend logs.', 'error');
    } finally {
      setDriveLoading(false);
    }
  };

  const sources = [
    {
      key: 'gmail',
      icon: <Mail size={22} />,
      title: 'Gmail',
      desc: 'Review the Google connection and sync recent email messages.',
      status: connections.gmail?.connected ? 'active' : 'inactive',
      statusLabel: connections.gmail === null ? 'Checking status' :
        connections.gmail.unavailable ? 'Status unavailable' :
          connections.gmail.connected ? 'Google connected' : 'Google not connected',
      onClick: () => setModal('gmail'),
    },
    {
      key: 'slack',
      icon: <Hash size={22} />,
      title: 'Slack channels',
      desc: 'Choose a public channel and sync its recent messages.',
      status: connections.slack?.configured ? 'active' : 'inactive',
      statusLabel: connections.slack === null ? 'Checking status' :
        connections.slack.unavailable ? 'Status unavailable' :
          connections.slack.configured ? 'Token configured' : 'Not configured',
      onClick: () => setModal('slack'),
    },
    {
      key: 'docs',
      icon: <FolderOpen size={22} />,
      title: 'Google Drive',
      desc: 'Preview and sync Google Docs from the configured Drive folder.',
      status: connections.docs?.connected && connections.docs?.driveFolderConfigured ? 'active' : 'inactive',
      statusLabel: connections.docs === null ? 'Checking status' :
        connections.docs.unavailable ? 'Status unavailable' :
          !connections.docs.connected ? 'Google not connected' :
            connections.docs.driveFolderConfigured ? 'Folder ready' : 'Folder not configured',
      onClick: handleOpenGDocs,
    },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Ingest data</h1>
          <div className="page-subtitle">Connect shared tools or add knowledge directly to your workspace.</div>
        </div>
      </div>

      <div className="page-body ingest-page-body">
        <section className="ingest-section" aria-labelledby="connected-sources-title">
          <div className="ingest-section-heading">
            <div>
              <h2 id="connected-sources-title">Connect a source</h2>
              <p>Review a connection, choose what to sync, and bring shared knowledge into Trace.AI.</p>
            </div>
            <span className="ingest-source-count">{sources.length} integrations</span>
          </div>
          <div className="ingest-grid">
            {sources.map((s) => (
              <button
                key={s.key}
                type="button"
                className="ingest-card liquid-sweep"
                onClick={s.onClick}
              >
                <div className="ingest-card-top">
                  <div className={`ingest-card-icon ${s.key}`} aria-hidden="true">{s.icon}</div>
                  <div className={`ingest-status ${s.status}`}>
                    {s.status === 'active' && <div className="status-dot" aria-hidden="true" />}
                    {s.statusLabel}
                  </div>
                </div>
                <div className="ingest-card-title">{s.title}</div>
                <div className="ingest-card-desc">{s.desc}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="ingest-manual-section" aria-labelledby="manual-ingest-title">
          <div className="ingest-section-heading">
            <div>
              <h2 id="manual-ingest-title">Add data manually</h2>
              <p>For knowledge that isn’t in a connected source. It will be analyzed and made searchable.</p>
            </div>
            <span className="ingest-source-count">No connection required</span>
          </div>
          <div className="manual-ingest-grid">
            <button
              type="button"
              className="manual-ingest-option"
              onClick={() => { setSource('manual'); setModal('manual'); }}
            >
              <span className="manual-ingest-icon text" aria-hidden="true"><FileText size={20} /></span>
              <span className="manual-ingest-copy">
                <span className="manual-ingest-name">Text, notes, or documents</span>
                <span className="manual-ingest-desc">Paste a document or useful context into the workspace.</span>
              </span>
              <span className="manual-ingest-action">Add text <ArrowRight size={15} aria-hidden="true" /></span>
            </button>
            <button
              type="button"
              className="manual-ingest-option"
              onClick={() => { setSource('transcript'); setModal('manual'); }}
            >
              <span className="manual-ingest-icon transcript" aria-hidden="true"><Mic size={20} /></span>
              <span className="manual-ingest-copy">
                <span className="manual-ingest-name">Meeting transcript</span>
                <span className="manual-ingest-desc">Add a conversation and extract decisions and follow-ups.</span>
              </span>
              <span className="manual-ingest-action">Add transcript <ArrowRight size={15} aria-hidden="true" /></span>
            </button>
          </div>
        </section>
      </div>

      {/* ─── GMAIL MODAL ─── */}
      {modal === 'gmail' && (
        <div className="modal-overlay" onClick={() => !loading && setModal(null)}>
          <div className="modal" tabIndex={-1} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Gmail force-sync">
            <div className="modal-header">
              <div className="modal-title"><Mail color="var(--gmail)" size={20} aria-hidden="true" /> Gmail Force-Sync</div>
              <button className="modal-close" onClick={() => setModal(null)} aria-label="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="modal-body">
              {connections.gmail?.connected ? (
                <p className="modal-copy">
                  Fetch recent Gmail messages. Existing messages are skipped; new messages are indexed with their source details.
                </p>
              ) : connections.gmail?.unavailable ? (
                <div className="modal-copy">
                  <p>Could not verify the Google connection.</p>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={refreshConnections}>Retry status check</button>
                </div>
              ) : (
                <div className="modal-copy">
                  <p>Connect a Google account before syncing Gmail.</p>
                  <a href={api.getGmailAuthUrl()} target="_blank" rel="noreferrer">Connect Google account</a>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={refreshConnections}>Refresh connection status</button>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleGmailFetch} disabled={loading || !connections.gmail?.connected} aria-busy={loading}>
                {loading ? <><div className="spinner border-spinner" aria-hidden="true" /> Syncing Gmail…</> : <><Mail size={15} aria-hidden="true" /> Force Sync</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── SLACK MODAL ─── */}
      {modal === 'slack' && (
        <SlackModal loading={loading} onClose={() => setModal(null)} onFetch={handleSlackFetch} />
      )}

      {/* ─── GOOGLE DOCS MODAL ─── */}
      {modal === 'gdocs' && (
        <div className="modal-overlay" onClick={() => !driveLoading && setModal(null)}>
          <div className="modal" tabIndex={-1} style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Google Drive documents">
            <div className="modal-header">
              <div className="modal-title">
                <FolderOpen color="var(--docs)" size={20} aria-hidden="true" /> Google Drive — Company Docs
              </div>
              <button className="modal-close" onClick={() => setModal(null)} aria-label="Close">
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="modal-body" style={{ maxHeight: 400 }}>
              {driveLoading && driveFiles.length === 0 ? (
                <div className="scan-state">
                  <div className="spinner" />
                  <div>Scanning Drive folder…</div>
                </div>
              ) : connections.docs === null ? (
                <div className="scan-state">
                  <div className="spinner" />
                  <div>Checking Google connection…</div>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={refreshDriveStatus}>Refresh status</button>
                </div>
              ) : connections.docs?.unavailable ? (
                <div className="scan-state">
                  <div className="glyph" aria-hidden="true"><AlertCircle size={20} /></div>
                  <div>Could not verify Google connection status.</div>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={refreshDriveStatus}>Retry status check</button>
                </div>
              ) : !connections.docs?.connected ? (
                <div className="scan-state">
                  <div className="glyph" aria-hidden="true"><Lock size={20} /></div>
                  <div>Connect Google to browse and sync Drive documents.</div>
                  <a href={api.getGmailAuthUrl()} target="_blank" rel="noreferrer">Connect Google account</a>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={refreshDriveStatus}>Refresh connection status</button>
                </div>
              ) : !connections.docs?.driveFolderConfigured ? (
                <div className="scan-state">
                  <div className="glyph" aria-hidden="true"><FolderOpen size={20} /></div>
                  <div>The Google Drive folder is not configured for this workspace.</div>
                </div>
              ) : driveError ? (
                <div className="scan-state" role="alert">
                  <div className="glyph" aria-hidden="true"><AlertCircle size={20} /></div>
                  <div>Could not load documents from the configured Drive folder.</div>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={loadDriveFiles}>Try again</button>
                </div>
              ) : driveFiles.length === 0 ? (
                <div className="scan-state">
                  <div className="glyph" aria-hidden="true"><FolderOpen size={22} /></div>
                  <div>No Google Docs found in the folder.</div>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={loadDriveFiles}>Check folder again</button>
                </div>
              ) : (
                <>
                  <div className="modal-note" style={{ marginBottom: 10 }}>
                    Found <strong>{driveFiles.length}</strong> Google Docs in your company folder
                  </div>
                  <div className="drive-list">
                    {driveFiles.map((f) => (
                      <div key={f.id} className={`drive-row ${f.alreadyIngested ? 'is-synced' : ''}`}>
                        <FileText size={16} className="drive-icon" aria-hidden="true" />
                        <div className="drive-text">
                          <div className="drive-name">{f.name}</div>
                          <div className="drive-meta">
                            by {f.owner} • {new Date(f.modifiedTime).toLocaleDateString()}
                          </div>
                        </div>
                        {f.alreadyIngested && <span className="drive-flag">Synced</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {syncResult && (
                <div className="drive-summary">
                  <Check size={16} aria-hidden="true" />
                  <span>
                    Ingested {syncResult.ingested_count} new docs
                    {syncResult.skipped_count > 0 ? ` • Skipped ${syncResult.skipped_count} (already synced)` : ''}
                  </span>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Close</button>
              <button className="btn btn-primary" onClick={handleSyncGDocs} disabled={driveLoading || driveFiles.length === 0} aria-busy={driveLoading}>
                {driveLoading ? <><div className="spinner border-spinner" aria-hidden="true" /> Syncing documents…</> : <><RefreshCw size={15} aria-hidden="true" /> Sync All Docs</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MANUAL INGEST MODAL ─── */}
      {modal === 'manual' && (
        <div className="modal-overlay" onClick={() => !loading && setModal(null)}>
          <div className="modal" tabIndex={-1} style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Knowledge upload">
            <div className="modal-header">
              <div className="modal-title">Knowledge Upload</div>
              <button className="modal-close" onClick={() => setModal(null)} aria-label="Close">
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group" style={{ marginBottom: 20 }}>
                <label className="form-label" htmlFor="ingest-source">Ingestion source</label>
                <select id="ingest-source" className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                  <option value="manual">Manual text or note</option>
                  <option value="transcript">Meeting transcript</option>
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: 20 }}>
                <label className="form-label" htmlFor="ingest-title">Document Title</label>
                <input
                  id="ingest-title"
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Q3 Pipeline Strategy Meeting"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="ingest-content">Raw Context</label>
                <textarea
                  id="ingest-content"
                  className="input"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Paste the raw text block, transcript log, or documentation here…"
                />
              </div>
            </div>

            <div className="modal-footer modal-footer-split">
              <span className="modal-note">This will be processed by the LLM before storing.</span>
              <div className="modal-footer-group">
                <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleManualIngest} disabled={loading || !title.trim() || !content.trim()} aria-busy={loading}>
                  {loading ? <><div className="spinner border-spinner" aria-hidden="true" /> Analyzing &amp; ingesting…</> : <span>Analyze &amp; Ingest</span>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── TOAST ─── */}
      {toast && (
        <div className="toast-container">
          <div className={`toast ${toast.type}`} role="status">{toast.msg}</div>
        </div>
      )}
    </>
  );
}

function SlackModal({ loading, onClose, onFetch }) {
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState('');
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState(false);

  useEffect(() => {
    let active = true;
    api.getSlackChannels()
      .then((data) => {
        if (!active) return;
        const available = data.channels || [];
        setChannels(available);
        setChannel(available[0]?.name || '');
      })
      .catch(() => {
        if (active) setChannelsError(true);
      })
      .finally(() => {
        if (active) setChannelsLoading(false);
      });

    return () => { active = false; };
  }, []);

  return (
    <div className="modal-overlay" onClick={() => !loading && onClose()}>
      <div className="modal" tabIndex={-1} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Target Slack channel">
        <div className="modal-header">
          <div className="modal-title"><Hash color="var(--slack)" size={20} aria-hidden="true" /> Target Slack Channel</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-copy" style={{ marginBottom: 18 }}>
            Sync recent messages from a public channel the Trace.AI Slack app can access.
          </p>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" htmlFor="slack-channel" style={{ marginBottom: 8 }}>Channel</label>
            {channelsLoading ? (
              <div className="scan-state compact"><div className="spinner" /><span>Loading public channels…</span></div>
            ) : channelsError ? (
              <>
                <input
                  id="slack-channel"
                  className="input"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value.replace(/^#/, ''))}
                  placeholder="e.g. engineering"
                  autoComplete="off"
                />
                <div className="hint">Could not load channels. Enter an exact public channel name; Slack will validate it.</div>
              </>
            ) : channels.length === 0 ? (
              <div className="hint">No public channels are available to this Slack app.</div>
            ) : (
              <select
                id="slack-channel"
                className="input"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                {channels.map((item) => <option key={item.id} value={item.name}>#{item.name}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onFetch(channel)} disabled={loading || channelsLoading || !channel.trim()} aria-busy={loading}>
            {loading ? <><div className="spinner border-spinner" aria-hidden="true" /> Syncing Slack…</> : <>Sync #{channel || 'channel'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
