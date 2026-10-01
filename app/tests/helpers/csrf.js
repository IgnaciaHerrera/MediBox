const request = require('supertest');

/**
 * Logs an agent in against POST /auth/login, first fetching a CSRF token
 * (issued by the `issueCsrfToken` middleware and exposed via the
 * `X-CSRF-Token` response header) so the request satisfies `verifyCsrf`.
 *
 * `request.agent(...)` persists the session cookie automatically across
 * requests made with the returned agent, so callers do not need to (and
 * should not) manually re-attach the `set-cookie` header themselves.
 *
 * Since `verifyCsrf` is now enforced on every non-GET request under `/api`
 * (and on `/auth/logout`), the returned agent's `post`/`patch`/`put`/`delete`
 * methods are wrapped so every subsequent mutating request automatically
 * carries the `X-CSRF-Token` header too — callers don't need to attach it
 * to each individual test request. The captured token is also exposed as
 * `agent.csrfToken` for the rare case a test needs it directly.
 */
async function loginAgent(app, credentials) {
  const agent = request.agent(app);
  const csrfRes = await agent.get('/health');
  const token = csrfRes.headers['x-csrf-token'];
  // Sent as a header (not a `_csrf` body field) so it never reaches the login
  // controller's Joi schema, which rejects unknown body keys.
  const loginRes = await agent.post('/auth/login').set('X-CSRF-Token', token).send(credentials);
  // Un login exitoso regenera la sesión y con ella el token CSRF, que llega
  // en la respuesta; uno fallido conserva la sesión anónima y su token.
  const tokenSesion = loginRes.status === 200 ? loginRes.headers['x-csrf-token'] : token;

  ['post', 'patch', 'put', 'delete'].forEach((method) => {
    const original = agent[method].bind(agent);
    agent[method] = (...args) => original(...args).set('X-CSRF-Token', tokenSesion);
  });
  agent.csrfToken = tokenSesion;

  return { agent, loginRes };
}

module.exports = { loginAgent };
