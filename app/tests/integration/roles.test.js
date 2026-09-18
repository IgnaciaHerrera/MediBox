const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('Gestión de roles y permisos (admin.roles)', () => {
  let usuarioAdmin;
  let usuarioNoAdmin;
  let rolConsulta;
  const password = 'Password123!';
  let permisosOriginalesConsulta;

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

    const asignaciones = await prisma.rolPermiso.findMany({ where: { rolId: rolConsulta.id }, include: { permiso: true } });
    permisosOriginalesConsulta = asignaciones.map((a) => a.permiso.clave);
  });

  afterAll(async () => {
    // Deja el rol `consulta` exactamente como estaba, ya que otros archivos de
    // test (rbac.test.js, seed.test.js) asumen su lista de permisos original.
    await prisma.rolPermiso.deleteMany({ where: { rolId: rolConsulta.id } });
    const permisos = await prisma.permiso.findMany({ where: { clave: { in: permisosOriginalesConsulta } } });
    await prisma.rolPermiso.createMany({ data: permisos.map((p) => ({ rolId: rolConsulta.id, permisoId: p.id })) });

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

    const res = await agent.patch(`/api/roles/${rolConsulta.id}`).send({ permisos: ['dashboard.read', 'agenda.read'] });
    expect(res.status).toBe(200);
    const claves = res.body.permisos.map((rp) => rp.permiso.clave).sort();
    expect(claves).toEqual(['agenda.read', 'dashboard.read']);
  });

  it('never lets the admin role lose admin.roles, even if the request omits it', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const { agent, loginRes } = await loginAgent(app, { email: 'roles-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.patch(`/api/roles/${rolAdmin.id}`).send({ permisos: ['dashboard.read'] });
    expect(res.status).toBe(200);
    const claves = res.body.permisos.map((rp) => rp.permiso.clave);
    expect(claves).toContain('admin.roles');

    // Restaura el rol admin a todos los permisos, ya que otros tests asumen esto.
    const todosLosPermisos = await prisma.permiso.findMany();
    await agent.patch(`/api/roles/${rolAdmin.id}`).send({ permisos: todosLosPermisos.map((p) => p.clave) });
  });
});
