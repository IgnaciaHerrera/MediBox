const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('Gestión de usuarios (admin.users)', () => {
  let usuarioAdmin;
  let usuarioNoAdmin;
  let rolConsulta;
  const password = 'Password123!';
  const usuarioIdsCreados = [];

  beforeAll(async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    rolConsulta = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'consulta' } });
    usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'usuarios-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Usuarios Test', email: 'usuarios-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    usuarioNoAdmin = await prisma.usuario.upsert({
      where: { email: 'usuarios-noadmin-test@medibox.local' },
      update: {},
      create: { nombre: 'No Admin Test', email: 'usuarios-noadmin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolConsulta.id },
    });
  });

  afterAll(async () => {
    if (usuarioIdsCreados.length > 0) {
      await prisma.usuario.deleteMany({ where: { id: { in: usuarioIdsCreados } } });
    }
    await prisma.usuario.deleteMany({ where: { id: { in: [usuarioAdmin.id, usuarioNoAdmin.id] } } });
    await prisma.$disconnect();
  });

  it('rejects a non-admin.users role with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'usuarios-noadmin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/usuarios');
    expect(res.status).toBe(403);
  });

  it('creates a new user with a hashed password, never returning it', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'usuarios-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.post('/api/usuarios').send({
      nombre: 'Usuario Nuevo Test', email: 'usuario-nuevo-test@medibox.local', password: 'Password123!', rolId: rolConsulta.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.passwordHash).toBeUndefined();
    usuarioIdsCreados.push(res.body.id);

    const stored = await prisma.usuario.findUnique({ where: { id: res.body.id } });
    expect(stored.passwordHash).not.toBe('Password123!');
  });

  it('rejects a password longer than the 72 bytes bcrypt can use', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'usuarios-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/usuarios').send({
      nombre: 'Clave Larga', email: 'usuario-clave-larga-test@medibox.local', password: 'x'.repeat(73), rolId: rolConsulta.id,
    });
    expect(res.status).toBe(400);
    expect(await prisma.usuario.findUnique({ where: { email: 'usuario-clave-larga-test@medibox.local' } })).toBeNull();
  });

  it('rejects creating a user with a duplicate email with 409', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'usuarios-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/usuarios').send({
      nombre: 'Duplicado', email: 'usuarios-admin-test@medibox.local', password: 'Password123!', rolId: rolConsulta.id,
    });
    expect(res.status).toBe(409);
  });

  it('updates a user name and role', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'usuarios-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/usuarios').send({
      nombre: 'Editable', email: 'usuario-editable-test@medibox.local', password: 'Password123!', rolId: rolConsulta.id,
    });
    usuarioIdsCreados.push(createRes.body.id);

    const updateRes = await agent.patch(`/api/usuarios/${createRes.body.id}`).send({ nombre: 'Editado', rolId: rolConsulta.id });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.nombre).toBe('Editado');
  });

  it('rejects an admin changing their own role, even via the JSON API directly', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const { agent, loginRes } = await loginAgent(app, { email: 'usuarios-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.patch(`/api/usuarios/${usuarioAdmin.id}`).send({ nombre: usuarioAdmin.nombre, rolId: rolConsulta.id });
    expect(res.status).toBe(400);

    const stored = await prisma.usuario.findUnique({ where: { id: usuarioAdmin.id } });
    expect(stored.rolId).toBe(rolAdmin.id);
  });
});
