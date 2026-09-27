import { Sun, Moon, Monitor } from 'lucide-react';

export default function SettingsPage({ theme, setTheme }) {
  const THEME_OPTIONS = [
    { id: 'light', label: 'Light Mode', icon: <Sun size={18} />, desc: 'Clean, stark white interface' },
    { id: 'dark', label: 'Dark Mode', icon: <Moon size={18} />, desc: 'High-contrast dark interface' },
    { id: 'system', label: 'System Default', icon: <Monitor size={18} />, desc: 'Follows your operating system' },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-subtitle">Manage preferences and system integrations</div>
        </div>
      </div>

      <div className="page-body">
        <div style={{ maxWidth: 820 }}>
          {/* Theme Section */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Appearance</span>
            </div>
            <div className="card-body">
              <span className="form-label" style={{ marginBottom: 14 }}>Interface Theme</span>

              <div className="theme-grid" role="radiogroup" aria-label="Interface theme">
                {THEME_OPTIONS.map((opt) => (
                  <div
                    key={opt.id}
                    className={`theme-card ${theme === opt.id ? 'is-active' : ''}`}
                    role="radio"
                    tabIndex={0}
                    aria-checked={theme === opt.id}
                    onClick={() => setTheme(opt.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setTheme(opt.id);
                      }
                    }}
                  >
                    <div className="theme-swatch" aria-hidden="true">{opt.icon}</div>
                    <div>
                      <div className="theme-name">{opt.label}</div>
                      <div className="theme-desc">{opt.desc}</div>
                    </div>
                    {theme === opt.id && <div className="theme-check" aria-hidden="true" />}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
