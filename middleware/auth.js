/**
 * middleware/auth.js — request authentication guards.
 *
 * These live outside routes/auth.js for one concrete reason: the guards are
 * needed by every router, so importing them from a route module makes the
 * dependency read backwards (routes/documents.js requiring routes/auth.js just
 * to get a function). routes/auth.js re-exports from here, so existing
 * `require('./auth').requireAuth` call sites keep working unchanged.
 *
 * Security notes for the guards below:
 *   - Every guard fails CLOSED. A missing or unverifiable token yields 401; a
 *     verified token that is no longer wanted also yields 401 (see tokenVersion
 *     in models/User.js). There is no path that lets a request through
 *     unexamined.
 *   - The user document is re-read from MongoDB on every request rather than
 *     trusted from the token body. A JWT is signed, but it is also a stale
 *     snapshot: it can still say "role: admin" after the role was removed, and
 *     it can name an account that has since been deleted. Reading the user is
 *     what makes revocation and role changes take effect immediately.
 *   - Errors distinguish "expired" from "invalid" deliberately, because the
 *     client needs to know to send the user back to the login screen.
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;

/** Throws if JWT_SECRET is absent, so a missing secret cannot silently pass. */
function requireSecret() {
  if (!JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to issue or verify tokens - a fallback ' +
        'secret would let anyone mint their own valid token.'
    );
  }
  return JWT_SECRET;
}

/**
 * Shared bearer-token guard for the data routes.
 * Populates req.user and req.auth; rejects with a consistent error shape.
 */
function requireAuth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'Server auth is not configured (JWT_SECRET missing).' });
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(header.slice(7).trim(), JWT_SECRET);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({ error: expired ? 'Session expired, sign in again' : 'Invalid token' });
  }

  User.findById(decoded.id)
    .select('-password')
    .then((user) => {
      if (!user) return res.status(401).json({ error: 'Account no longer exists' });

      // Server-side revocation. A signed token proves it was issued by this
      // server, not that it is still wanted. Comparing the tv claim against the
      // stored value makes logout effective immediately rather than at expiry,
      // and also lets a deleted session or a downgraded role take effect at once.
      const tokenVersion = decoded.tv || 0;
      if ((user.tokenVersion || 0) !== tokenVersion) {
        return res.status(401).json({ error: 'Session ended, sign in again' });
      }

      req.user = user;
      req.auth = decoded;
      next();
    })
    .catch((err) => next(err));
}

/**
 * Require a specific role.
 *
 * Mount AFTER requireAuth, which populates req.user. Kept separate rather than
 * folded into requireAuth because the role check needs the user document that
 * requireAuth has already loaded - re-querying would be a wasted round trip.
 */
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requireSecret, JWT_SECRET };