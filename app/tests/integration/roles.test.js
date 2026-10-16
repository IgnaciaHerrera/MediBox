const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('Gestión de roles y permisos (admin.roles)', () => {
  let usuarioAdmin;
  let rolConsulta;
  let rolPrueba;
  let rolOtroAdmin;
  const password = 'Password123!';

  beforeAll(async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    rolConsulta = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'consulta' } });
    usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'roles-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Roles Test', email: 'roles-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    await prisma.usuario.upsert({
      where: { email: 'roles-noadmin-test@medibox.local' },
      update: {},
      create: { nombre: 'No Admin Roles Test', email: 'roles-noadmin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolConsulta.id },
    });

    // Rol propio de este archivo: los roles del seed (consulta, admin, ...)
    // los usan otros archivos de test que Jest corre en paralelo, así que
    // modificarlos aquí hacía fallar esos tests al azar.
    rolPrueba = await prisma.rol.upsert({ where: { nombre: 'roles-test' }, update: {}, create: { nombre: 'roles-test' } });

    // Otro rol con admin.roles: el admin no puede editar su propio rol, así
    // que la salvaguarda del rol admin se prueba desde uno distinto.
    rolOtroAdmin = await prisma.rol.upsert({ where: { nombre: 'roles-test-otro-admin' }, update: {}, create: { nombre: 'roles-test-otro-admin' } });
    const permisoRoles = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'admin.roles' } });
    await prisma.rolPermiso.upsert({
      where: { rolId_permisoId: { rolId: rolOtroAdmin.id, permisoId: permisoRoles.id } },
      update: {},
      create: { rolId: rolOtroAdmin.id, permisoId: permisoRoles.id },
    });
    await prisma.usuario.upsert({
      where: { email: 'roles-otroadmin-test@medibox.local' },
      update: {},
      create: { nombre: 'Otro Admin Roles Test', email: 'roles-otroadmin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolOtroAdmin.id },
    });
  });

  afterAll(async () => {
    // Los usuarios de prueba (y sus roles) se conservan y se reutilizan con
    // upsert: tienen filas en la auditoría, que es de solo inserción.
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

    // El cambio de acceso queda en la auditoría, a nombre de quien lo hizo.
    const auditoria = await prisma.auditLog.findMany({
      where: { usuarioId: usuarioAdmin.id, accion: 'UPDATE_PERMISOS', entidad: 'Rol', entidadId: rolPrueba.id },
    });
    expect(auditoria.length).toBeGreaterThanOrEqual(1);
  });

  it('never lets the admin change the permissions of their own role, but accepts resending them unchanged', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' }, include: { permisos: { include: { permiso: true } } } });
    const actuales = rolAdmin.permisos.map((rp) => rp.permiso.clave);
    const { agent } = await loginAgent(app, { email: 'roles-admin-test@medibox.local', password });

    const ampliar = await agent.patch(`/api/roles/${rolAdmin.id}`).send({ permisos: [...actuales, 'paciente.read'] });
    expect(ampliar.status).toBe(403);
    const despues = await prisma.rolPermiso.count({ where: { rolId: rolAdmin.id } });
    expect(despues).toBe(actuales.length);

    // La matriz de roles reenvía todos los roles, incluido el propio.
    const igual = await agent.patch(`/api/roles/${rolAdmin.id}`).send({ permisos: actuales });
    expect(igual.status).toBe(200);
  });

  it('never lets the admin role lose admin.roles, even if the request omits it', async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' }, include: { permisos: { include: { permiso: true } } } });
    const actuales = rolAdmin.permisos.map((rp) => rp.permiso.clave);
    const { agent, loginRes } = await loginAgent(app, { email: 'roles-otroadmin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    // Se envían los permisos actuales menos admin.roles: así se prueba la
    // salvaguarda sin quitarle nada real al rol admin, que otros archivos de
    // test usan al mismo tiempo.
    const res = await agent.patch(`/api/roles/${rolAdmin.id}`).send({ permisos: actuales.filter((c) => c !== 'admin.roles') });
    expect(res.status).toBe(200);
    const claves = res.body.permisos.map((rp) => rp.permiso.clave);
    expect(claves).toContain('admin.roles');
    expect(claves).toHaveLength(actuales.length);
  });
});
