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
    await prisma.auditLog.deleteMany({ where: { usuarioId: usuarioGestor.id } });
    await prisma.usuario.delete({ where: { id: usuarioGestor.id } });
    await prisma.$disconnect();
  });

  it('returns paginated audit entries for a user with auditoria.read', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'auditoria-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/auditoria');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});
