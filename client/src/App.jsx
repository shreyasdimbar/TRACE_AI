import { useState, useEffect } from 'react';
import { LayoutDashboard, MessageSquare, FileText, Upload, Settings, LogOut } from 'lucide-react';
import DashboardPage from './pages/DashboardPage';
import AskPage from './pages/AskPage';
import FeedPage from './pages/FeedPage';
import IngestPage from './pages/IngestPage';
import SettingsPage from './pages/SettingsPage';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import './index.css';

const WORKSPACE_ITEMS = [
  { key: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { key: 'ask', label: 'Ask Anything', icon: MessageSquare },
  { key: 'feed', label: 'Documents', icon: FileText, badge: '0' },
];

const INTEGRATION_ITEMS = [
  { key: 'ingest', label: 'Ingest Data', icon: Upload },
  { key: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'system');
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [view, setView] = useState('landing'); // 'landing' | 'login' | 'app'
  const [authLoading, setAuthLoading] = useState(true);

  // On mount: check for persisted session
  useEffect(() => {
    const savedToken = localStorage.getItem('trace_token');
    const savedUser = localStorage.getItem('trace_user');

    if (savedToken && savedUser) {
      // Validate token with backend
      fetch('http://localhost:5000/api/auth/me', {
        headers: { Authorization: `Bearer ${savedToken}` },
      })
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Token expired');
        })
        .then((data) => {
          setUser(data.user);
          setToken(savedToken);
          setView('app');
        })
        .catch(() => {
          localStorage.removeItem('trace_token');
          localStorage.removeItem('trace_user');
          setView('landing');
        })
        .finally(() => setAuthLoading(false));
    } else {
      setAuthLoading(false);
    }
  }, []);

  // Theme effect
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', theme);
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const handleLogin = (userData, jwt) => {
    setUser(userData);
    setToken(jwt);
    setView('app');
    setPage('dashboard');
  };

  const handleLogout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('trace_token');
    localStorage.removeItem('trace_user');
    setView('landing');
  };

  const renderPage = () => {
    switch (page) {
      case 'dashboard': return <DashboardPage setPage={setPage} />;
      case 'ask': return <AskPage />;
      case 'feed': return <FeedPage />;
      case 'ingest': return <IngestPage />;
      case 'settings': return <SettingsPage theme={theme} setTheme={setTheme} />;
      default: return <DashboardPage setPage={setPage} />;
    }
  };

  // Loading spinner while verifying token
  if (authLoading) {
    return (
      <div className="boot">
        <div className="atmosphere" aria-hidden="true">
          <span className="atm-blob atm-aqua" />
          <span className="atm-blob atm-ice" />
          <span className="atm-caustic" />
        </div>
        <div className="boot-inner">
          <div className="logo-mark" aria-hidden="true">~</div>
          <div className="spinner" />
          <span>Verifying session…</span>
        </div>
      </div>
    );
  }

  // Auth gateway
  if (view === 'landing') {
    return <LandingPage onNavigate={setView} />;
  }

  if (view === 'login') {
    return <LoginPage onLogin={handleLogin} onNavigate={setView} />;
  }

  // Extract user initials
  const userInitial = user?.name?.charAt(0)?.toUpperCase() || 'U';
  const userName = user?.name || 'User';
  const userRole = user?.role === 'admin' ? 'Administrator' : 'Member';

  const renderNavGroup = (items) =>
    items.map((item) => (
      <button
        key={item.key}
        className={`nav-item ${page === item.key ? 'active' : ''}`}
        onClick={() => setPage(item.key)}
        id={`nav-${item.key}`}
        aria-current={page === item.key ? 'page' : undefined}
        title={item.label}
      >
        <item.icon className="nav-icon" size={16} aria-hidden="true" />
        <span style={{ flex: 1 }}>{item.label}</span>
        {item.badge && <span className="nav-badge">{item.badge}</span>}
      </button>
    ));

  return (
    <>
      {/* ─── ATMOSPHERE ─── */}
      <div className="atmosphere" aria-hidden="true">
        <span className="atm-blob atm-aqua" />
        <span className="atm-blob atm-ice" />
        <span className="atm-blob atm-silver" />
        <span className="atm-blob atm-coral" />
        <span className="atm-caustic" />
        <span className="atm-grain" />
      </div>

      <div className="app-layout">
        {/* ─── SIDEBAR ─── */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-logo">
              <div className="logo-mark" aria-hidden="true">~</div>
              <div className="logo-text">Trace.AI</div>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label="Primary">
            <div className="nav-section-label">Workspace</div>
            {renderNavGroup(WORKSPACE_ITEMS)}
            <div className="nav-section-label">Integrations</div>
            {renderNavGroup(INTEGRATION_ITEMS)}
          </nav>

          <div className="sidebar-footer">
            <div className="user-avatar" style={{ width: 30, height: 30, fontSize: 12 }} aria-hidden="true">
              {userInitial}
            </div>
            <div className="user-info">
              <span className="user-name">{userName}</span>
              <span className="user-role">{userRole}</span>
            </div>
            <button className="icon-btn" onClick={handleLogout} title="Logout" aria-label="Log out">
              <LogOut size={16} aria-hidden="true" />
            </button>
          </div>
        </aside>

        {/* ─── MAIN ─── */}
        <main className="main-content">{renderPage()}</main>
      </div>
    </>
  );
}
