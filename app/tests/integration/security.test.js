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

  it('rejects a login POST without a valid CSRF token', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'admin@medibox.local', password: 'Admin123!' });
    expect(res.status).toBe(403);
  });

  it('rate-limits repeated login attempts from the same client', async () => {
    const agent = request.agent(app);
    // `request.agent` persists the session cookie automatically across requests,
    // so there is no need to (and no correct way to, given supertest/superagent's
    // handling of a raw `set-cookie` array) manually re-attach it per request.
    await agent.get('/health');

    let lastStatus;
    for (let i = 0; i < 11; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await agent.post('/auth/login').send({ email: 'nadie@medibox.local', password: 'x' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
