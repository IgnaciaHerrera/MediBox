const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('GET /api/especialidades', () => {
  let usuario;
  const password = 'Password123!';

  beforeAll(async () => {
    const rol = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'medico' } });
    usuario = await prisma.usuario.upsert({
      where: { email: 'especialidad-test@medibox.local' },
      update: {},
      create: {
        nombre: 'Test',
        email: 'especialidad-test@medibox.local',
        passwordHash: await bcrypt.hash(password, 12),
        rolId: rol.id,
      },
    });
    await prisma.especialidad.upsert({ where: { nombre: 'Cardiología' }, update: {}, create: { nombre: 'Cardiología' } });
  });

  afterAll(async () => {
    await prisma.usuario.delete({ where: { id: usuario.id } });
    await prisma.$disconnect();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/especialidades');
    expect(res.status).toBe(401);
  });

  it('returns the seeded specialties for an authenticated medico user', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'especialidad-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/especialidades');
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.nombre === 'Cardiología')).toBe(true);
  });
});
