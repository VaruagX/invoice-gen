const { HttpError } = require("../lib/http");

/** Conservative security headers. The client uses no inline scripts, so CSP can forbid them. */
function securityHeaders({ isProduction }) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");

  return (req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    next();
  };
}

/**
 * CSRF protection for the JSON API. State-changing requests must carry the
 * X-Requested-With header (which a cross-site form cannot set without a CORS
 * preflight that our CORS policy rejects) and, when the browser sends one, an
 * Origin matching this application.
 */
function csrfGuard({ allowedOrigins }) {
  const allowed = new Set(allowedOrigins.filter(Boolean));
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.get("x-requested-with") !== "fetch") {
      return next(new HttpError(403, "Request blocked: missing request header."));
    }
    const origin = req.get("origin");
    if (origin) {
      const selfOrigin = `${req.protocol}://${req.get("host")}`;
      if (origin !== selfOrigin && !allowed.has(origin)) {
        return next(new HttpError(403, "Request blocked: cross-site request."));
      }
    }
    if (req.get("sec-fetch-site") === "cross-site") {
      return next(new HttpError(403, "Request blocked: cross-site request."));
    }
    next();
  };
}

/**
 * Fixed-window in-memory rate limiter. Suitable for a single instance; use a
 * shared store if the app is scaled horizontally.
 */
function rateLimit({ windowMs, max, keyPrefix, message, key }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 30000));
  timer.unref?.();

  return (req, res, next) => {
    const id = `${keyPrefix}:${key ? key(req) : req.user?.id || req.ip}`;
    const now = Date.now();
    let entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(id, entry);
    }
    entry.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(new HttpError(429, message || "Too many requests. Please wait a moment and try again."));
    }
    next();
  };
}

module.exports = { securityHeaders, csrfGuard, rateLimit };
