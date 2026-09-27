import { useState } from 'react';
import { ArrowRight, Mail, Lock, User, Eye, EyeOff, AlertCircle } from 'lucide-react';

export default function LoginPage({ onLogin, onNavigate }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const API_BASE = 'http://localhost:5000';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = mode === 'register' ? { name, email, password } : { email, password };

      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed');

      localStorage.setItem('trace_token', data.token);
      localStorage.setItem('trace_user', JSON.stringify(data.user));
      onLogin(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const PERKS = [
    { glyph: '🔒', text: 'JWT-secured authentication' },
    { glyph: '🎓', text: 'Exclusive to @walchandsangli.ac.in' },
    { glyph: '⚡', text: 'AI-powered knowledge extraction' },
  ];

  return (
    <div className="auth-page">
      {/* Atmospheric layered background */}
      <div className="landing-bg" aria-hidden="true">
        <span className="bg-gradient bg-gradient-1" />
        <span className="bg-gradient bg-gradient-2" />
        <span className="bg-gradient bg-gradient-3" />
        <span className="bg-grid" />
        <span className="atm-grain" />
      </div>

      <div className="auth-card">
        {/* Left brand panel */}
        <div className="auth-brand">
          <div className="auth-brand-inner">
            <div className="auth-brand-lockup">
              <div className="logo-mark" style={{ width: 38, height: 38, fontSize: 19 }} aria-hidden="true">~</div>
              <span style={{ fontWeight: 800, fontSize: 23, letterSpacing: '-0.03em' }}>Trace.AI</span>
            </div>

            <h2 className="auth-headline">
              Your organization's<br />
              <span className="landing-title-accent">intelligence layer.</span>
            </h2>

            <p className="auth-blurb">
              Query across Gmail, Slack, docs, and transcripts with AI-powered reasoning.
              Every answer comes with full source citations.
            </p>

            <div className="auth-perks">
              {PERKS.map((item, i) => (
                <div key={i} className="auth-perk">
                  <span className="glyph" aria-hidden="true">{item.glyph}</span>
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right form panel */}
        <div className="auth-form-panel">
          <div className="auth-form-wrap">
            <div className="auth-intro">
              <h2>
                {mode === 'login' ? 'Welcome back' : 'Create your account'}
              </h2>
              <p>
                {mode === 'login'
                  ? 'Sign in with your Walchand email to continue'
                  : 'Register with your @walchandsangli.ac.in email'}
              </p>
            </div>

            {error && (
              <div className="auth-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="auth-form">
              {mode === 'register' && (
                <div className="auth-field">
                  <label className="auth-label" htmlFor="auth-name">
                    <User size={14} aria-hidden="true" /> Full Name
                  </label>
                  <input
                    id="auth-name"
                    className="auth-input"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Pratap Dabhade"
                    autoComplete="name"
                    required
                  />
                </div>
              )}

              <div className="auth-field">
                <label className="auth-label" htmlFor="auth-email">
                  <Mail size={14} aria-hidden="true" /> Email
                </label>
                <input
                  id="auth-email"
                  className="auth-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="pratap.dabhade@walchandsangli.ac.in"
                  autoComplete="email"
                  required
                />
              </div>

              <div className="auth-field">
                <label className="auth-label" htmlFor="auth-password">
                  <Lock size={14} aria-hidden="true" /> Password
                </label>
                <div className="auth-input-wrap">
                  <input
                    id="auth-password"
                    className="auth-input"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 6 characters"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    className="auth-toggle-pw"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  </button>
                </div>
              </div>

              <button type="submit" className="btn btn-primary auth-submit" disabled={loading}>
                {loading ? (
                  <div className="spinner border-spinner" />
                ) : (
                  <>{mode === 'login' ? 'Sign In' : 'Create Account'} <ArrowRight size={16} aria-hidden="true" /></>
                )}
              </button>
            </form>

            <div className="auth-switch">
              {mode === 'login' ? (
                <p>Don't have an account? <button type="button" onClick={() => { setMode('register'); setError(''); }}>Register</button></p>
              ) : (
                <p>Already have an account? <button type="button" onClick={() => { setMode('login'); setError(''); }}>Sign In</button></p>
              )}
            </div>

            <button type="button" className="auth-back" onClick={() => onNavigate('landing')}>
              ← Back to home
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
