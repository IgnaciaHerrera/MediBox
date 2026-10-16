const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const auditService = require('../../src/services/auditService');
const { loginAgent } = require('../helpers/csrf');

describe('GET /api/auditoria', () => {
  let usuarioGestor;
  const password = 'Password123!';

  beforeAll(async () => {
    const rolGestor = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'gestor' } });
    usuarioGestor = await prisma.usuario.upsert({
      where: { email: 'auditoria-test@medibox.local' },
      update: {},
      create: { nombre: 'Gestor Auditoria', email: 'auditoria-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolGestor.id },
    });
    await auditService.registrar({ usuarioId: usuarioGestor.id, accion: 'READ', entidad: 'Paciente', entidadId: 1 });
  });

  afterAll(async () => {
    // Los usuarios de prueba (y sus roles) se conservan y se reutilizan con
    // upsert: tienen filas en la auditoría, que es de solo inserción.
    await prisma.$disconnect();
  });

  it('returns paginated audit entries for a user with auditoria.read', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'auditoria-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    // Filtrada por el gestor de la prueba: la fila más reciente de toda la
    // auditoría puede ser del sistema o del portal, que no tienen usuario.
    const res = await agent.get('/api/auditoria').query({ usuarioId: usuarioGestor.id });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    // Solo el nombre de quien actuó: nunca el hash ni el correo de su cuenta.
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$|email/);
    expect(Object.keys(res.body.items[0].usuario).sort()).toEqual(['id', 'nombre']);
  });

  it('filters by accion, entidad and usuarioId', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'auditoria-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const porAccion = await agent.get('/api/auditoria').query({ accion: 'READ', usuarioId: usuarioGestor.id });
    expect(porAccion.status).toBe(200);
    expect(porAccion.body.items.every((r) => r.accion === 'READ' && r.usuarioId === usuarioGestor.id)).toBe(true);

    const porEntidadEquivocada = await agent.get('/api/auditoria').query({ entidad: 'Cita', usuarioId: usuarioGestor.id });
    expect(porEntidadEquivocada.status).toBe(200);
    expect(porEntidadEquivocada.body.items.length).toBe(0);
  });

  it('filters by date range', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'auditoria-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const manana = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const futuro = await agent.get('/api/auditoria').query({ desde: manana, usuarioId: usuarioGestor.id });
    expect(futuro.status).toBe(200);
    expect(futuro.body.items.length).toBe(0);

    const hoy = new Date().toISOString().slice(0, 10);
    const desdeHoy = await agent.get('/api/auditoria').query({ desde: hoy, usuarioId: usuarioGestor.id });
    expect(desdeHoy.status).toBe(200);
    expect(desdeHoy.body.items.length).toBeGreaterThanOrEqual(1);
  });
});
