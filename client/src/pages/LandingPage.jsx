import { ArrowRight, Shield, Zap, Mail, Hash, FileText, Mic, ChevronDown } from 'lucide-react';

export default function LandingPage({ onNavigate }) {
  const sources = [
    { icon: <Mail size={20} />, label: 'Gmail', color: 'var(--gmail)' },
    { icon: <Hash size={20} />, label: 'Slack', color: 'var(--slack)' },
    { icon: <FileText size={20} />, label: 'Docs', color: 'var(--docs)' },
    { icon: <Mic size={20} />, label: 'Transcripts', color: 'var(--transcript)' },
  ];

  return (
    <div className="landing">
      {/* Atmospheric layered background */}
      <div className="landing-bg" aria-hidden="true">
        <span className="bg-gradient bg-gradient-1" />
        <span className="bg-gradient bg-gradient-2" />
        <span className="bg-gradient bg-gradient-3" />
        <span className="bg-gradient bg-gradient-4" />
        <span className="bg-grid" />
        <span className="atm-grain" />
      </div>

      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav-left">
          <div className="landing-logo-icon" aria-hidden="true"><FileText size={18} /></div>
          <span className="landing-logo-text">Trace<span style={{ fontWeight: 300 }}>.AI</span></span>
        </div>
        <div className="landing-nav-right">
          <span className="landing-tag">Nexora Technologies workspace</span>
          <button className="landing-nav-cta" onClick={() => onNavigate('login')}>
            Get Started <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-copy">
          <div className="landing-badge">
            <div className="landing-badge-dot" aria-hidden="true" />
            <span>Organizational knowledge, with sources</span>
          </div>

          <h1 className="landing-title">
            Your Knowledge,<br />
            <span className="landing-title-accent">Connected.</span>
          </h1>

          <p className="landing-desc">
            Bring Gmail, Slack, Google Docs, and transcripts into one searchable workspace.
            Ask questions and follow answers back to their source.
          </p>

          <div className="landing-actions">
            <button className="landing-cta-main" onClick={() => onNavigate('login')}>
              <Zap size={17} aria-hidden="true" />
              Open Trace.AI
            </button>
            <button
              className="landing-cta-outline"
              onClick={() => {
                const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
                document.querySelector('.landing-sources')?.scrollIntoView({ behavior });
              }}
            >
              Explore sources <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <aside className="landing-workflow" aria-label="How Trace.AI works">
          <div className="landing-workflow-heading">
            <span className="landing-workflow-kicker">A clear path from source to answer</span>
            <h2>Knowledge you can trace.</h2>
          </div>
          <ol className="landing-workflow-list">
            <li>
              <span className="landing-workflow-number">01</span>
              <div>
                <strong>Connect your sources</strong>
                <p>Bring in the conversations and documents your team already uses.</p>
              </div>
            </li>
            <li>
              <span className="landing-workflow-number">02</span>
              <div>
                <strong>Build shared context</strong>
                <p>Trace.AI organizes knowledge for search and decision history.</p>
              </div>
            </li>
            <li>
              <span className="landing-workflow-number">03</span>
              <div>
                <strong>Ask and verify</strong>
                <p>Get answers with citations back to the indexed material.</p>
              </div>
            </li>
          </ol>
        </aside>
      </section>

      {/* Sources */}
      <section className="landing-sources">
        <div className="landing-divider">
          <span className="landing-divider-line" />
          <span className="landing-divider-text">Supported sources</span>
          <span className="landing-divider-line" />
        </div>

        <div className="landing-source-row">
          {sources.map((s, i) => (
            <div key={i} className="landing-source-chip liquid-sweep">
              <div className="landing-source-icon" style={{ color: s.color }} aria-hidden="true">
                {s.icon}
              </div>
              <span className="landing-source-label">{s.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Security */}
      <section className="landing-security">
        <div className="landing-security-card">
          <Shield size={28} aria-hidden="true" />
          <div>
            <h3>Enterprise Security</h3>
            <p>Organization email verification with JWT and bcrypt-secured access.</p>
          </div>
          <button className="landing-cta-main landing-cta-sm" onClick={() => onNavigate('login')}>
            Sign In
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-left">
          <span style={{ fontWeight: 700 }}>Trace.AI</span>
          <span className="sep" aria-hidden="true">•</span>
          <span>SunHacks 2026</span>
        </div>
        <span>Nexora Technologies</span>
      </footer>
    </div>
  );
}
