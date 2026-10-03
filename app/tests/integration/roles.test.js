const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('Gestión de roles y permisos (admin.roles)', () => {
  let usuarioAdmin;
  let usuarioNoAdmin;
  let rolConsulta;
  let rolPrueba;
  const password = 'Password123!';

  beforeAll(async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    rolConsulta = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'consulta' } });
    usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'roles-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Roles Test', email: 'roles-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    usuarioNoAdmin = await prisma.usuario.upsert({
      where: { email: 'roles-noadmin-test@medibox.local' },
      update: {},
      create: { nombre: 'No Admin Roles Test', email: 'roles-noadmin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolConsulta.id },
    });

    // Rol propio de este archivo: los roles del seed (consulta, admin, ...)
    // los usan otros archivos de test que Jest corre en paralelo, así que
    // modificarlos aquí hacía fallar esos tests al azar.
    rolPrueba = await prisma.rol.upsert({ where: { nombre: 'roles-test' }, update: {}, create: { nombre: 'roles-test' } });
  });

  afterAll(async () => {
    await prisma.rolPermiso.deleteMany({ where: { rolId: rolPrueba.id } });
    await prisma.rol.delete({ where: { id: rolPrueba.id } });
    await prisma.usuario.deleteMany({ where: { id: { in: [usuarioAdmin.id, usuarioNoAdmin.id] } } });
    await prisma.$disconnect();
  });

  it('rejects a non-admin.roles role with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'roles-noadmin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/roles');
    expect(res.status).toBe(403);
  });

  it('replaces the permission set of a role', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'roles-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.patch(`/api/roles/${rolPrueba.id}`).send({ permisos: ['dashboard.read', 'agenda.read'] });
    expect(res.status).toBe(200);
    const claves = res.body.permisos.map((rp) => rp.permiso.clave).sort();
    expect(claves).toEqual(['agenda.read', 'dashboard.read']);
  });

  it('never lets the admin role lose admin.roles, even if the request omits it', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const { agent, loginRes } = await loginAgent(app, { email: 'roles-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    // Se envían todos los permisos menos admin.roles: así se prueba la
    // salvaguarda sin quitarle nada real al rol admin, que otros archivos de
    // test usan al mismo tiempo.
    const todosLosPermisos = (await prisma.permiso.findMany()).map((p) => p.clave);
    const sinAdminRoles = todosLosPermisos.filter((clave) => clave !== 'admin.roles');

    const res = await agent.patch(`/api/roles/${rolAdmin.id}`).send({ permisos: sinAdminRoles });
    expect(res.status).toBe(200);
    const claves = res.body.permisos.map((rp) => rp.permiso.clave);
    expect(claves).toContain('admin.roles');
    expect(claves).toHaveLength(todosLosPermisos.length);
  });
});
