import { useState, useRef, useEffect } from 'react';
import { Mail, Hash, FileText, Mic, Upload, X, ChevronDown, Check, FolderOpen, RefreshCw } from 'lucide-react';
import { api } from '../api';

function CustomSelect({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (ref.current && !ref.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [ref]);

  const selectedOption = options.find((o) => o.value === value) || options[0];

  return (
    <div className="custom-select-container" ref={ref}>
      <div
        className={`custom-select-trigger ${open ? 'open' : ''}`}
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ color: selectedOption.color || 'inherit', display: 'flex' }} aria-hidden="true">
            {selectedOption.icon}
          </span>
          <span>{selectedOption.label}</span>
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          style={{ color: 'var(--text-tertiary)', flex: 'none', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.22s' }}
        />
      </div>

      {open && (
        <div className="custom-select-dropdown" role="listbox">
          {options.map((opt) => (
            <div
              key={opt.value}
              className="custom-select-item"
              role="option"
              aria-selected={value === opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span style={{ color: opt.color || 'inherit', width: 20, display: 'flex', justifyContent: 'center', flex: 'none' }} aria-hidden="true">
                {opt.icon}
              </span>
              <span style={{ flex: 1, fontWeight: value === opt.value ? 700 : 500 }}>{opt.label}</span>
              {value === opt.value && <Check size={14} color="var(--a-400)" aria-hidden="true" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const [syncResult, setSyncResult] = useState(null);

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
  const handleOpenGDocs = async () => {
    setModal('gdocs');
    setDriveLoading(true);
    setSyncResult(null);
    try {
      const data = await api.listDriveDocs();
      setDriveFiles(data.files || []);
    } catch (err) {
      setDriveFiles([]);
      showToast('Could not list Drive files. Ensure OAuth is connected with Drive scope.', 'error');
    } finally {
      setDriveLoading(false);
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
      title: 'Gmail Context',
      desc: 'Auto-polling every 60s. Tap to force a manual fetch.',
      status: 'active',
      statusLabel: 'Auto-sync active',
      onClick: () => setModal('gmail'),
    },
    {
      key: 'slack',
      icon: <Hash size={22} />,
      title: 'Slack Engine',
      desc: 'Ingests threads and DMs instantly from public channels.',
      status: 'active',
      statusLabel: 'Auto-sync active',
      onClick: () => setModal('slack'),
    },
    {
      key: 'docs',
      icon: <FolderOpen size={22} />,
      title: 'Google Drive Docs',
      desc: 'Sync Google Docs from your company shared Drive folder.',
      status: 'active',
      statusLabel: 'Drive Connected',
      onClick: handleOpenGDocs,
    },
    {
      key: 'transcript',
      icon: <Mic size={22} />,
      title: 'Meeting Transcript',
      desc: 'Drop a Zoom/Meet transcript to auto-extract action items.',
      status: 'inactive',
      statusLabel: 'Manual Input',
      onClick: () => { setSource('transcript'); setModal('manual'); },
    },
  ];

  const sourceOptions = [
    { value: 'manual', label: 'Plain Text Note', icon: <FileText size={16} />, color: 'var(--text-secondary)' },
    { value: 'transcript', label: 'Meeting Transcript', icon: <Mic size={16} />, color: 'var(--transcript)' },
    { value: 'google_docs', label: 'Google Document', icon: <FileText size={16} />, color: 'var(--docs)' },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Ingest Data</div>
          <div className="page-subtitle">Inject knowledge chunks into your organizational graph</div>
        </div>
        <div className="page-head-actions">
          <button
            className="btn btn-primary"
            onClick={() => { setSource('manual'); setModal('manual'); }}
          >
            <Upload size={16} aria-hidden="true" />
            Manual Upload
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="ingest-grid">
          {sources.map((s) => (
            <div
              key={s.key}
              className="ingest-card liquid-sweep"
              role="button"
              tabIndex={0}
              onClick={s.onClick}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  s.onClick();
                }
              }}
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
            </div>
          ))}
        </div>
      </div>

      {/* ─── GMAIL MODAL ─── */}
      {modal === 'gmail' && (
        <div className="modal-overlay" onClick={() => !loading && setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Gmail force-sync">
            <div className="modal-header">
              <div className="modal-title"><Mail color="var(--gmail)" size={20} aria-hidden="true" /> Gmail Force-Sync</div>
              <button className="modal-close" onClick={() => setModal(null)} aria-label="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-copy">
                The ingestion engine already auto-polls Gmail every 60 seconds. Push this to trigger an immediate, manual sync of the 10 latest threads.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleGmailFetch} disabled={loading}>
                {loading ? <div className="spinner border-spinner" /> : <><Mail size={15} aria-hidden="true" /> Force Sync</>}
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
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Google Drive documents">
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
              ) : driveFiles.length === 0 ? (
                <div className="scan-state">
                  <div className="glyph" aria-hidden="true">📂</div>
                  <div>No Google Docs found in the folder.</div>
                  <div className="hint">
                    Make sure OAuth has Drive scope. Visit{' '}
                    <a href="http://localhost:5000/auth/google" target="_blank" rel="noreferrer">/auth/google</a>{' '}
                    to re-authenticate.
                  </div>
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
                  <span aria-hidden="true">✅</span>
                  <span>
                    Ingested {syncResult.ingested_count} new docs
                    {syncResult.skipped_count > 0 ? ` • Skipped ${syncResult.skipped_count} (already synced)` : ''}
                  </span>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Close</button>
              <button className="btn btn-primary" onClick={handleSyncGDocs} disabled={driveLoading || driveFiles.length === 0}>
                {driveLoading ? <div className="spinner border-spinner" /> : <><RefreshCw size={15} aria-hidden="true" /> Sync All Docs</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MANUAL INGEST MODAL ─── */}
      {modal === 'manual' && (
        <div className="modal-overlay" onClick={() => !loading && setModal(null)}>
          <div className="modal" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Knowledge upload">
            <div className="modal-header">
              <div className="modal-title">Knowledge Upload</div>
              <button className="modal-close" onClick={() => setModal(null)} aria-label="Close">
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group" style={{ marginBottom: 20 }}>
                <span className="form-label">Ingestion Source</span>
                <CustomSelect value={source} onChange={setSource} options={sourceOptions} />
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
                <button className="btn btn-primary" onClick={handleManualIngest} disabled={loading || !title.trim() || !content.trim()}>
                  {loading ? <div className="spinner border-spinner" /> : <span>Analyze &amp; Ingest</span>}
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
  const [channel, setChannel] = useState('general');

  return (
    <div className="modal-overlay" onClick={() => !loading && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Target Slack channel">
        <div className="modal-header">
          <div className="modal-title"><Hash color="var(--slack)" size={20} aria-hidden="true" /> Target Slack Channel</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-copy" style={{ marginBottom: 18 }}>
            Specify a target channel to forcefully sync the most recent messages.
          </p>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" htmlFor="slack-channel" style={{ marginBottom: 8 }}>Channel</label>
            <input
              id="slack-channel"
              className="input"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="e.g. engineering"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onFetch(channel)} disabled={loading || !channel.trim()}>
            {loading ? <div className="spinner border-spinner" /> : <>Pull #{channel}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
