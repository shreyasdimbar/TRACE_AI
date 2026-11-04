import { Sun, Moon, Monitor, Check } from 'lucide-react';

export default function SettingsPage({ theme, setTheme }) {
  const THEME_OPTIONS = [
    { id: 'light', label: 'Light Mode', icon: <Sun size={18} />, desc: 'Clean, stark white interface' },
    { id: 'dark', label: 'Dark Mode', icon: <Moon size={18} />, desc: 'High-contrast dark interface' },
    { id: 'system', label: 'System Default', icon: <Monitor size={18} />, desc: 'Follows your operating system' },
  ];
  const selectedTheme = THEME_OPTIONS.find((option) => option.id === theme) || THEME_OPTIONS[2];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-subtitle">Manage your personal preferences for Trace.AI.</div>
        </div>
      </div>

      <div className="page-body settings-page-body">
        <section className="settings-section" aria-labelledby="settings-appearance-title">
          <div className="settings-section-heading">
            <div>
              <h2 id="settings-appearance-title">Appearance</h2>
              <p>Choose a display mode for your workspace.</p>
            </div>
            <span className="settings-scope-badge">Device preference</span>
          </div>

          <div className="settings-layout">
            <section className="card settings-theme-card" aria-labelledby="settings-theme-title">
              <div className="card-body">
                <div className="settings-theme-heading">
                  <h3 id="settings-theme-title">Interface theme</h3>
                  <p>Your selection is applied immediately.</p>
                </div>

                <div className="theme-grid" role="radiogroup" aria-label="Interface theme">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`theme-card ${theme === opt.id ? 'is-active' : ''}`}
                      role="radio"
                      tabIndex={theme === opt.id ? 0 : -1}
                      aria-checked={theme === opt.id}
                      onClick={() => setTheme(opt.id)}
                      onKeyDown={(e) => {
                        const current = THEME_OPTIONS.findIndex((item) => item.id === theme);
                        let next = current;
                        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (current + 1) % THEME_OPTIONS.length;
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (current - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
                        if (next !== current) {
                          e.preventDefault();
                          setTheme(THEME_OPTIONS[next].id);
                          e.currentTarget.parentElement?.querySelectorAll('[role="radio"]')[next]?.focus();
                        }
                      }}
                    >
                      <div className="theme-swatch" aria-hidden="true">{opt.icon}</div>
                      <div>
                        <div className="theme-name">{opt.label}</div>
                        <div className="theme-desc">{opt.desc}</div>
                      </div>
                      {theme === opt.id && <div className="theme-check" aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <aside className="settings-current-card">
              <span className="settings-current-label">Current preference</span>
              <div className="settings-current-icon" aria-hidden="true">{selectedTheme.icon}</div>
              <h3>{selectedTheme.label}</h3>
              <p>{selectedTheme.desc}</p>
              <div className="settings-current-note">
                <Check size={15} aria-hidden="true" />
                <span>Saved in this browser</span>
              </div>
              <p className="settings-scope-note">This preference only affects your device, not other workspace members.</p>
            </aside>
          </div>
        </section>
      </div>
    </>
  );
}
