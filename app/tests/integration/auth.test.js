const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('POST /auth/login', () => {
  let rol;

  beforeAll(async () => {
    rol = await prisma.rol.upsert({ where: { nombre: 'consulta' }, update: {}, create: { nombre: 'consulta' } });
    await prisma.usuario.upsert({
      where: { email: 'test-login@medibox.local' },
      update: {},
      create: {
        nombre: 'Test Login',
        email: 'test-login@medibox.local',
        passwordHash: await bcrypt.hash('Password123!', 12),
        rolId: rol.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.usuario.delete({ where: { email: 'test-login@medibox.local' } });
    await prisma.$disconnect();
  });

  it('rejects invalid credentials with 401', async () => {
    const { loginRes } = await loginAgent(app, { email: 'test-login@medibox.local', password: 'incorrecta' });
    expect(loginRes.status).toBe(401);
  });

  it('accepts valid credentials and sets a session cookie', async () => {
    const { loginRes } = await loginAgent(app, { email: 'test-login@medibox.local', password: 'Password123!' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers['set-cookie']).toBeDefined();
  });

  it('issues a new session id on login, so a cookie planted before login is useless (session fixation)', async () => {
    const anonima = await request(app).get('/health');
    const cookieAnonima = anonima.headers['set-cookie'][0].split(';')[0];

    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookieAnonima)
      .set('X-CSRF-Token', anonima.headers['x-csrf-token'])
      .send({ email: 'test-login@medibox.local', password: 'Password123!' });
    expect(loginRes.status).toBe(200);
    const cookieAutenticada = loginRes.headers['set-cookie'][0].split(';')[0];
    expect(cookieAutenticada).not.toBe(cookieAnonima);
    expect(loginRes.headers['x-csrf-token']).not.toBe(anonima.headers['x-csrf-token']);

    expect((await request(app).get('/api/notificaciones').set('Cookie', cookieAnonima)).status).toBe(401);
    expect((await request(app).get('/api/notificaciones').set('Cookie', cookieAutenticada)).status).toBe(200);
  });

  it('a protected route rejects requests without a session', async () => {
    const { requireAuth } = require('../../src/middleware/requireAuth');
    const express = require('express');
    const testApp = express();
    testApp.get('/protegido', requireAuth, (req, res) => res.json({ ok: true }));
    const res = await request(testApp).get('/protegido');
    expect(res.status).toBe(401);
  });
});
