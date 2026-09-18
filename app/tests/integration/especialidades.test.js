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
    await prisma.especialidad.deleteMany({ where: { nombre: { in: ['Especialidad Editada Test'] } } });
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

  it('rejects updating a specialty from a non-admin role with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'especialidad-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const especialidad = await prisma.especialidad.findUniqueOrThrow({ where: { nombre: 'Cardiología' } });
    const res = await agent.patch(`/api/especialidades/${especialidad.id}`).send({ nombre: 'No debería aplicar' });
    expect(res.status).toBe(403);
  });

  it('allows an admin to rename a specialty', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'especialidad-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Test', email: 'especialidad-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    const especialidad = await prisma.especialidad.create({ data: { nombre: 'Especialidad Editada Test' } });

    const { agent, loginRes } = await loginAgent(app, { email: 'especialidad-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.patch(`/api/especialidades/${especialidad.id}`).send({ nombre: 'Especialidad Editada Test 2' });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('Especialidad Editada Test 2');

    await prisma.especialidad.delete({ where: { id: especialidad.id } });
    await prisma.usuario.delete({ where: { id: usuarioAdmin.id } });
  });

  it('rejects a duplicate specialty name with 409', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'especialidad-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Test', email: 'especialidad-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    const { agent, loginRes } = await loginAgent(app, { email: 'especialidad-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.post('/api/especialidades').send({ nombre: 'Cardiología' });
    expect(res.status).toBe(409);

    await prisma.usuario.delete({ where: { id: usuarioAdmin.id } });
  });

  it('rejects deleting a specialty with médicos assigned, and allows it once empty', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'especialidad-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Test', email: 'especialidad-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    const { agent, loginRes } = await loginAgent(app, { email: 'especialidad-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const conMedicoRes = await agent.post('/api/especialidades').send({ nombre: 'Especialidad Con Medico Test' });
    await agent.post('/api/medicos').send({ nombre: 'Dr. Especialidad Test', especialidadId: conMedicoRes.body.id });

    const bloqueado = await agent.delete(`/api/especialidades/${conMedicoRes.body.id}`);
    expect(bloqueado.status).toBe(400);

    const vaciaRes = await agent.post('/api/especialidades').send({ nombre: 'Especialidad Vacia Test' });
    const permitido = await agent.delete(`/api/especialidades/${vaciaRes.body.id}`);
    expect(permitido.status).toBe(204);

    await prisma.medico.deleteMany({ where: { nombre: 'Dr. Especialidad Test' } });
    await prisma.especialidad.delete({ where: { id: conMedicoRes.body.id } });
    await prisma.usuario.delete({ where: { id: usuarioAdmin.id } });
  });
});
