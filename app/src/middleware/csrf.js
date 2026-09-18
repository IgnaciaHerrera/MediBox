const crypto = require('crypto');

function issueCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  // Also exposed as a response header so API-only clients (and tests) can read
  // the token to echo it back via `_csrf`/`x-csrf-token` on state-changing requests.
  res.set('X-CSRF-Token', req.session.csrfToken);
  next();
}

function verifyCsrf(req, res, next) {
  const tokenFromRequest = req.body._csrf || req.headers['x-csrf-token'];
  if (!tokenFromRequest || tokenFromRequest !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Token CSRF inválido o ausente' });
  }
  return next();
}

module.exports = { issueCsrfToken, verifyCsrf };
