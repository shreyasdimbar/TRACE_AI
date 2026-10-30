/**
 * rateLimit — in-process request limiting for the auth routes.
 *
 * Deliberately dependency-free: the login limit has to key on *email + IP*
 * together, because limiting on IP alone lets one host spray many addresses
 * while limiting on email alone lets a bot rotate addresses. express-rate-limit
 * cannot express that pairing without a custom key generator and more moving
 * parts than this needs.
 *
 * Scope and limits of this approach, so nobody is misled:
 *  - State lives in this process only. A restart clears it, and with N instances
 *    behind a load balancer the effective limit is N times what is configured.
 *    For a single-process deployment that is fine; for anything else, back this
 *    with Redis and the same interface.
 *  - Fixed window, not sliding. A client can burn its quota at the end of one
 *    window and the start of the next. Acceptable for credential stuffing, which
 *    is what this is for; switch to a sliding log if it ever needs to be tighter.
 */

/**
 * @param {object}   opts
 * @param {number}   opts.windowMs   quota window length
 * @param {number}   opts.max        requests allowed per window
 * @param {function} opts.keyFn      (req) => string
 * @param {string}   opts.code       machine-readable error code
 * @param {string}   opts.message    human-readable error message
 */
function createLimiter({ windowMs, max, keyFn, code, message }) {
  const hits = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    // Amortised cleanup: only walk the map occasionally, not on every request.
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }

  return function limiter(req, res, next) {
    const now = Date.now();
    sweep(now);

    let key;
    try {
      key = keyFn(req);
    } catch {
      key = 'unknown';
    }

    const entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', '0');
      return res.status(429).json({ error: message, code, retryAfterSeconds: retryAfter });
    }

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    return next();
  };
}

/** Best-effort client address, honouring a single proxy hop. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function normaliseEmail(req) {
  return String(req.body?.email || '').trim().toLowerCase();
}

module.exports = { createLimiter, clientIp, normaliseEmail };
