const request = require('supertest');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');

describe('Security middleware', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('sets common security headers via helmet', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('solo permite fuentes y estilos de este mismo sitio', async () => {
    const res = await request(app).get('/health');
    const directivas = Object.fromEntries(
      res.headers['content-security-policy'].split(';').map((d) => {
        const [nombre, ...valores] = d.trim().split(/\s+/);
        return [nombre, valores];
      }),
    );
    expect(directivas['font-src']).toEqual(["'self'"]);
    expect(directivas['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directivas['script-src']).toEqual(["'self'"]);
  });

  it('las páginas públicas no cargan nada de otros sitios', async () => {
    for (const ruta of ['/', '/auth/login-form', '/portal', '/privacidad']) {
      const res = await request(app).get(ruta).set('Accept', 'text/html');
      const externos = res.text.match(/(?:href|src)="https?:\/\/[^"]+"/g) || [];
      expect(externos).toEqual([]);
    }
  });

  it('rejects a login POST without a valid CSRF token', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'admin@medibox.local', password: 'Admin123!' });
    expect(res.status).toBe(403);
  });

  it('rate-limits repeated login attempts from the same client', async () => {
    const agent = request.agent(app);
    // `request.agent` persists the session cookie automatically across requests,
    // so there is no need to (and no correct way to, given supertest/superagent's
    // handling of a raw `set-cookie` array) manually re-attach it per request.
    // CSRF is now checked globally before the request reaches the rate limiter
    // (app.js), so a valid token must be attached on every attempt for these
    // to actually reach — and exhaust — the limiter, rather than all failing
    // at the CSRF check before ever being counted.
    const healthRes = await agent.get('/health');
    const csrfToken = healthRes.headers['x-csrf-token'];

    let lastStatus;
    for (let i = 0; i < 11; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await agent
        .post('/auth/login')
        .set('X-CSRF-Token', csrfToken)
        .send({ email: 'nadie@medibox.local', password: 'x' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
