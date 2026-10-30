import { useState, useEffect, useSyncExternalStore } from 'react';
import { LayoutDashboard, MessageSquare, FileText, Upload, Settings, LogOut } from 'lucide-react';
import DashboardPage from './pages/DashboardPage';
import AskPage from './pages/AskPage';
import FeedPage from './pages/FeedPage';
import IngestPage from './pages/IngestPage';
import SettingsPage from './pages/SettingsPage';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import {
  navigate,
  rememberIntended,
  consumeIntended,
  DEFAULT_AUTHED_ROUTE,
} from './routes';
import { useRoute } from './router';
import { subscribe, getSession, bootstrap, adoptSession, signOut } from './session';
import './index.css';

// Nav entries are keyed by ROUTE rather than by page name. Previously `page`
// was a React state string ('feed'); now the URL is the truth, so each item
// carries the path it navigates to.
const WORKSPACE_ITEMS = [
  { path: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { path: '/ask', label: 'Ask Anything', icon: MessageSquare },
  { path: '/documents', label: 'Documents', icon: FileText, badge: '0' },
];

const INTEGRATION_ITEMS = [
  { path: '/ingest', label: 'Ingest Data', icon: Upload },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'system');

  // Session lives in an external store so every consumer re-renders on change
  // without this component threading auth state through props.
  const session = useSyncExternalStore(subscribe, getSession, getSession);
  const { status, user } = session;

  const { path, intended, renderPath } = useRoute(session);

  // Verify any stored token once on boot.
  useEffect(() => {
    bootstrap();
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

  /**
   * Navigate to a workspace route.
   *
   * Pages still call this via a `setPage`-shaped prop (DashboardPage does), so
   * those call sites are unchanged - the mapping from old page names to real
   * paths is contained here.
   */
  const go = (pageOrPath) => {
    // Legacy page-name aliasing, so `setPage('feed')` keeps working.
    const ALIASES = { feed: '/documents', documents: '/documents' };
    navigate(ALIASES[pageOrPath] || pageOrPath);
  };

  const handleLogin = (userData, jwt) => {
    adoptSession(userData, jwt);
    // Return the user to whatever protected page sent them here, if any.
    navigate(consumeIntended(DEFAULT_AUTHED_ROUTE), { replace: true });
  };

  const handleLogout = () => {
    signOut({ navigateTo: () => navigate('/', { replace: true }) });
  };

  /** Landing and login pass an onNavigate that used to switch `view`. */
  const handlePublicNavigate = (view) => {
    if (view === 'login') {
      rememberIntended(intended);
      navigate('/login');
    } else {
      navigate('/');
    }
  };

  const renderPage = () => {
    switch (renderPath) {
      case '/dashboard': return <DashboardPage setPage={go} />;
      case '/ask': return <AskPage />;
      case '/documents': return <FeedPage />;
      case '/ingest': return <IngestPage />;
      case '/settings': return <SettingsPage theme={theme} setTheme={setTheme} />;
      default: return null;
    }
  };

  // Session still being verified: hold on the boot screen. Rendering the login
  // page here instead would flash it at a signed-in user on every refresh.
  if (status === 'loading') {
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

  // Public shell: landing and login render outside the app chrome.
  if (status === 'anonymous') {
    if (path === '/login' || renderPath === '/login') {
      return <LoginPage onLogin={handleLogin} onNavigate={handlePublicNavigate} />;
    }
    return <LandingPage onNavigate={handlePublicNavigate} />;
  }

  // A protected URL reached while anonymous has already been redirected by
  // useRoute, so anything past this point is a genuine authenticated route.

  // Extract user initials
  const userInitial = user?.name?.charAt(0)?.toUpperCase() || 'U';
  const userName = user?.name || 'User';
  const userRole = user?.role === 'admin' ? 'Administrator' : 'Member';

  const renderNavGroup = (items) =>
    items.map((item) => (
      <button
        key={item.path}
        className={`nav-item ${path === item.path ? 'active' : ''}`}
        onClick={() => navigate(item.path)}
        id={`nav-${item.path.replace('/', '')}`}
        aria-current={path === item.path ? 'page' : undefined}
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
