const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { createLimiter, clientIp, normaliseEmail } = require('../services/rateLimit');
const { requireAuth, requireRole, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// The guards themselves now live in middleware/auth.js. Re-exported at the
// bottom so the many `require('../routes/auth').requireAuth` call sites keep
// working without churn.
//
// A missing JWT_SECRET is logged loudly rather than thrown, so the server still
// boots and /health still answers for diagnostics. Every protected route then
// returns 500 rather than admitting traffic, so failing closed is preserved.
if (!JWT_SECRET) {
  console.error('[auth] JWT_SECRET is not set. Refusing to issue or verify tokens.');
}

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || 'walchandsangli.ac.in')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const TOKEN_TTL = process.env.JWT_TTL || '7d';

/* ── Rate limiting ──────────────────────────────────────────
   Two limits, because either one alone is trivially evaded:
     - per (IP + email): stops repeated guesses at one account
     - per IP:          stops one host rotating through many accounts
   A successful login clears the pair's counter so a legitimate user who
   fat-fingers a few times is not left locked out.                          */
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX = Number(process.env.LOGIN_RATE_MAX || 8);
const LOGIN_IP_MAX = Number(process.env.LOGIN_IP_RATE_MAX || 40);
const REGISTER_MAX = Number(process.env.REGISTER_RATE_MAX || 5);

const loginByAccount = createLimiter({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_MAX,
  keyFn: (req) => `${clientIp(req)}|${normaliseEmail(req)}`,
  code: 'RATE_LIMITED',
  message: 'Too many sign-in attempts. Wait a few minutes and try again.',
});

const loginByIp = createLimiter({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_IP_MAX,
  keyFn: (req) => clientIp(req),
  code: 'RATE_LIMITED',
  message: 'Too many sign-in attempts from this network. Wait a few minutes and try again.',
});

const registerByIp = createLimiter({
  windowMs: LOGIN_WINDOW_MS,
  max: REGISTER_MAX,
  keyFn: (req) => clientIp(req),
  code: 'RATE_LIMITED',
  message: 'Too many accounts created from this network. Try again later.',
});

function generateToken(user) {
  return jwt.sign(
    {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      // Recorded so the token can be revoked server-side; see models/User.js.
      // `|| 0` keeps tokens minted before this field existed verifiable.
      tv: user.tokenVersion || 0,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    organization: user.organization,
  };
}

function domainOf(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}

function isAllowedEmail(email) {
  return ALLOWED_DOMAINS.includes(domainOf(email));
}

/* ── POST /api/auth/register ─────────────────────────────── */
router.post('/register', registerByIp, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    if (name.length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!isAllowedEmail(email)) {
      return res.status(403).json({
        error: `Access restricted to ${ALLOWED_DOMAINS.join(', ')} organization members only.`,
      });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (password.length > 200) {
      return res.status(400).json({ error: 'Password must be 200 characters or fewer' });
    }
    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Server auth is not configured (JWT_SECRET missing).' });
    }

    const existing = await User.findOne({ email }).lean();
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Please login.' });
    }

    const user = await User.create({ name, email, password });
    res.status(201).json({ token: generateToken(user), user: publicUser(user) });
  } catch (err) {
    // Duplicate-key race: two registrations for the same address at once.
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists. Please login.' });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join(' ') });
    }
    next(err);
  }
});

/* ── POST /api/auth/login ────────────────────────────────── */
router.post('/login', loginByIp, loginByAccount, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!isAllowedEmail(email)) {
      return res.status(403).json({
        error: `Access restricted to ${ALLOWED_DOMAINS.join(', ')} organization members only.`,
      });
    }
    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Server auth is not configured (JWT_SECRET missing).' });
    }

    const user = await User.findOne({ email });
    // Compare against a dummy hash when the user is missing so that a wrong
    // email and a wrong password take the same amount of time.
    const isMatch = user
      ? await user.comparePassword(password)
      : await User.prototype.comparePassword.call(
          { password: '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv' },
          password
        );

    if (!user || !isMatch) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    res.json({ token: generateToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/* ── GET /api/auth/me ────────────────────────────────────── */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ user: publicUser(req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── POST /api/auth/logout ─────────────────────────────────
   Bumping tokenVersion invalidates every token ever issued to this account,
   not just the one presented here. That matters because the token is normally
   in localStorage, where any XSS or shared-machine reader can lift it; making
   logout actually revoke is what stops a copied token outliving the session.

   A new token is returned so the caller can stay signed in if it wants to
   continue working in the same tab (e.g. "sign out of other devices").
   ---------------------------------------------------------------------- */
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const { keepSignedIn } = req.body || {};

    const bumped = await User.findByIdAndUpdate(
      req.user._id,
      { $inc: { tokenVersion: 1 }, $set: { lastLogoutAt: new Date() } },
      { new: true }
    ).select('-password');

    if (!bumped) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    // Change-password style confirmation: re-issue against the new version.
    const token = keepSignedIn ? generateToken(bumped) : null;

    res.json({
      success: true,
      revoked: true,
      ...(token ? { token, user: publicUser(bumped) } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/* ── GET /api/auth/config ────────────────────────────────── */
router.get('/config', (req, res) => {
  res.json({ allowedDomains: ALLOWED_DOMAINS, tokenTtl: TOKEN_TTL });
});

module.exports = router;
// Re-exported so existing `require('./auth').requireAuth` call sites are
// unchanged; the implementations live in middleware/auth.js.
module.exports.requireAuth = requireAuth;
module.exports.requireRole = requireRole;
module.exports.ALLOWED_DOMAINS = ALLOWED_DOMAINS;
