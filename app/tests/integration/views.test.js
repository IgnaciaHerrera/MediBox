const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');

describe('Views', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('renders the login form with a CSRF token embedded', async () => {
    const res = await request(app).get('/auth/login-form');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="_csrf"');
  });

  it('redirects unauthenticated dashboard requests to a 401 (no session)', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(401);
  });

  it('sends a browser without a session back to the login form instead of a JSON 401', async () => {
    const res = await request(app).get('/dashboard').set('Accept', 'text/html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login-form');

    const api = await request(app).get('/api/notificaciones').set('Accept', 'text/html');
    expect(api.status).toBe(401);
  });

  describe('full browser flow (login form -> dashboard -> logout)', () => {
    let rol;

    beforeAll(async () => {
      rol = await prisma.rol.upsert({ where: { nombre: 'consulta' }, update: {}, create: { nombre: 'consulta' } });
      await prisma.usuario.upsert({
        where: { email: 'test-view-flow@medibox.local' },
        update: {},
        create: {
          nombre: 'Test View Flow',
          email: 'test-view-flow@medibox.local',
          passwordHash: await bcrypt.hash('Password123!', 12),
          rolId: rol.id,
        },
      });
    });

    afterAll(async () => {
      await prisma.usuario.delete({ where: { email: 'test-view-flow@medibox.local' } });
    });

    it('logs in via the HTML form, reaches the dashboard, and logs out — all via redirects', async () => {
      const agent = request.agent(app);

      // 1. Load the login form to obtain the embedded CSRF token, exactly as
      //    a real browser would before submitting the form.
      const formRes = await agent.get('/auth/login-form');
      expect(formRes.status).toBe(200);
      const match = formRes.text.match(/name="_csrf" value="([^"]+)"/);
      expect(match).not.toBeNull();
      const csrfToken = match[1];

      // 2. Submit the login form as a browser would: urlencoded body carrying
      //    `_csrf`, and an Accept header preferring HTML.
      const loginRes = await agent
        .post('/auth/login')
        .type('form')
        .set('Accept', 'text/html,application/xhtml+xml')
        .send({ email: 'test-view-flow@medibox.local', password: 'Password123!', _csrf: csrfToken });
      expect(loginRes.status).toBe(302);
      expect(loginRes.headers.location).toBe('/dashboard');

      // 3. Follow the redirect to the dashboard using the session cookie.
      const dashboardRes = await agent.get('/dashboard');
      expect(dashboardRes.status).toBe(200);
      // The dashboard greets by first name only (design choice), not the full name.
      expect(dashboardRes.text).toContain('Hola, Test');

      // 4. Log out as a browser form submission and confirm the redirect
      //    target, then confirm the session is actually gone. `/auth/logout`
      //    is CSRF-protected, and login regenerates the session (against
      //    session fixation), so the form carries the new session's token —
      //    the one rendered in the dashboard, not the pre-login one.
      const tokenSesion = dashboardRes.text.match(/name="_csrf" value="([^"]+)"/)[1];
      expect(tokenSesion).not.toBe(csrfToken);
      const logoutRes = await agent
        .post('/auth/logout')
        .type('form')
        .set('Accept', 'text/html,application/xhtml+xml')
        .send({ _csrf: tokenSesion });
      expect(logoutRes.status).toBe(302);
      expect(logoutRes.headers.location).toBe('/auth/login-form');

      const afterLogoutRes = await agent.get('/dashboard');
      expect(afterLogoutRes.status).toBe(401);
    });
  });
});
