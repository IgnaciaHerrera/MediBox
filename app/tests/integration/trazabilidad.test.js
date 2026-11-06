const crypto = require('crypto');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba } = require('../helpers/datos');

// Eventos que la trazabilidad exige y que no se auditaban: cierres de
// sesión, intentos negados fuera de los pacientes, cambios en los médicos y
// las consultas a la propia auditoría.
describe('trazabilidad: eventos auditados', () => {
  const password = 'Password123!';
  const sufijo = crypto.randomBytes(4).toString('hex');
  let operador;
  let gestor;
  let admin;

  beforeAll(async () => {
    operador = await usuarioDePrueba(`traz-operador-${sufijo}@medibox.local`, 'operador', password);
    gestor = await usuarioDePrueba(`traz-gestor-${sufijo}@medibox.local`, 'gestor', password);
    admin = await usuarioDePrueba(`traz-admin-${sufijo}@medibox.local`, 'admin', password);
  });

  afterAll(() => prisma.$disconnect());

  const ultima = (where) => prisma.auditLog.findFirst({ where, orderBy: { id: 'desc' } });

  it('el cierre de sesión queda registrado, con la IP', async () => {
    const { agent } = await loginAgent(app, { email: operador.email, password });
    expect((await agent.post('/auth/logout').send({})).status).toBe(200);
    const fila = await ultima({ accion: 'LOGOUT', usuarioId: operador.id });
    expect(fila).toEqual(
      expect.objectContaining({ entidad: 'Usuario', entidadId: operador.id, resultado: 'exito' }),
    );
    expect(fila.ip).toEqual(expect.stringContaining('127.0.0.1'));
  });

  it('un intento negado sobre cuentas o roles queda como ACCESO_DENEGADO, con el permiso y la ruta', async () => {
    const { agent } = await loginAgent(app, { email: operador.email, password });
    expect((await agent.get('/usuarios')).status).toBe(403);
    const fila = await ultima({ accion: 'ACCESO_DENEGADO', usuarioId: operador.id });
    expect(fila).toEqual(expect.objectContaining({ resultado: 'denegado', entidad: 'Sistema' }));
    expect(fila.detalle).toEqual({ permisos: ['admin.users'], metodo: 'GET', ruta: '/usuarios' });
  });

  it('crear, cambiar y eliminar un médico queda registrado con quién lo hizo', async () => {
    const { agent } = await loginAgent(app, { email: admin.email, password });
    const especialidad = await prisma.especialidad.findFirst();
    const creado = await agent
      .post('/api/medicos')
      .send({ nombre: `Dr. Prueba ${sufijo}`, especialidadId: especialidad.id });
    expect(creado.status).toBe(201);
    await agent
      .patch(`/api/medicos/${creado.body.id}`)
      .send({ nombre: `Dr. Prueba ${sufijo} B`, especialidadId: especialidad.id });
    await agent.delete(`/api/medicos/${creado.body.id}`);
    const filas = await prisma.auditLog.findMany({
      where: { entidad: 'Medico', entidadId: creado.body.id },
      orderBy: { id: 'asc' },
    });
    expect(filas.map((f) => f.accion)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    expect(filas.every((f) => f.usuarioId === admin.id)).toBe(true);
    expect(filas[1].detalle.campos).toEqual(expect.arrayContaining(['nombre', 'especialidadId']));
  });

  it('consultar la auditoría también se audita, y los filtros se validan', async () => {
    const { agent } = await loginAgent(app, { email: gestor.email, password });
    expect(
      (await agent.get('/auditoria?accion=LOGIN&page=2').set('Accept', 'text/html')).status,
    ).toBe(200);
    const fila = await ultima({ accion: 'LIST', entidad: 'AuditLog', usuarioId: gestor.id });
    expect(fila.detalle).toEqual({ page: 2, accion: 'LOGIN' });
    expect((await agent.get('/api/auditoria?accion=nada%40correo.cl')).status).toBe(400);
  });
});
