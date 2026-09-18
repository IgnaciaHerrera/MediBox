const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('POST /api/medicos', () => {
  let usuarioAdmin;
  let usuarioMedico;
  let especialidad;
  const password = 'Password123!';

  beforeAll(async () => {
    especialidad = await prisma.especialidad.upsert({ where: { nombre: 'Neurología' }, update: {}, create: { nombre: 'Neurología' } });
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const rolMedico = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'medico' } });
    usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'medico-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Test', email: 'medico-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    usuarioMedico = await prisma.usuario.upsert({
      where: { email: 'medico-user-test@medibox.local' },
      update: {},
      create: { nombre: 'Medico Test', email: 'medico-user-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolMedico.id },
    });
  });

  afterAll(async () => {
    await prisma.usuario.deleteMany({ where: { id: { in: [usuarioAdmin.id, usuarioMedico.id] } } });
    await prisma.$disconnect();
  });

  it('rejects creation from a non-admin role with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'medico-user-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/medicos').send({ nombre: 'Dr. Rechazado', especialidadId: especialidad.id });
    expect(res.status).toBe(403);
  });

  it('allows creation from an admin role and returns 201', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'medico-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/medicos').send({ nombre: 'Dr. Aceptado', especialidadId: especialidad.id });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Dr. Aceptado');
  });
});
