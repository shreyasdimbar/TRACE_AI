import { useState, useEffect } from 'react';
import { ArrowRight, Shield, Zap, Mail, Hash, FileText, Mic, ChevronDown } from 'lucide-react';

export default function LandingPage({ onNavigate }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTimeout(() => setMounted(true), 50);
  }, []);

  const sources = [
    { icon: <Mail size={20} />, label: 'Gmail', color: 'var(--gmail)' },
    { icon: <Hash size={20} />, label: 'Slack', color: 'var(--slack)' },
    { icon: <FileText size={20} />, label: 'Docs', color: 'var(--docs)' },
    { icon: <Mic size={20} />, label: 'Transcripts', color: 'var(--transcript)' },
  ];

  return (
    <div className={`landing ${mounted ? 'mounted' : ''}`}>
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
          <div className="landing-logo-icon" aria-hidden="true">~</div>
          <span className="landing-logo-text">Trace<span style={{ fontWeight: 300 }}>.AI</span></span>
        </div>
        <div className="landing-nav-right">
          <span className="landing-tag">Walchand College Edition</span>
          <button className="landing-nav-cta" onClick={() => onNavigate('login')}>
            Get Started <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-badge">
          <div className="landing-badge-dot" aria-hidden="true" />
          <span>Organizational Intelligence Engine</span>
        </div>

        <h1 className="landing-title">
          Your Knowledge,<br />
          <span className="landing-title-accent">Unified.</span>
        </h1>

        <p className="landing-desc">
          Connect Gmail, Slack, and Docs. Ask anything.<br />
          Get answers with full source citations instantly.
        </p>

        <div className="landing-actions">
          <button className="landing-cta-main" onClick={() => onNavigate('login')}>
            <Zap size={18} aria-hidden="true" />
            Launch Application
          </button>
          <button
            className="landing-cta-outline"
            onClick={() => {
              document.querySelector('.landing-sources')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            Explore Sources <ChevronDown size={16} aria-hidden="true" />
          </button>
        </div>
      </section>

      {/* Sources */}
      <section className="landing-sources">
        <div className="landing-divider">
          <span className="landing-divider-line" />
          <span className="landing-divider-text">Connected Sources</span>
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
            <p>Strict <strong>@walchandsangli.ac.in</strong> domain lock. JWT + Bcrypt protection.</p>
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
        <span>Walchand College of Engineering, Sangli</span>
      </footer>
    </div>
  );
}
