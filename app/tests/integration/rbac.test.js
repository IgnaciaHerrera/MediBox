const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { prisma } = require('../../src/lib/prisma');
const { attachUsuario } = require('../../src/middleware/attachUsuario');
const { requirePermission } = require('../../src/middleware/requirePermission');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.post('/fake-login/:usuarioId', (req, res) => {
    req.session.usuarioId = Number(req.params.usuarioId);
    res.json({ ok: true });
  });
  app.get('/solo-pacientes', attachUsuario, requirePermission('paciente.read'), (req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('RBAC: paciente.read is not implied by agenda.read', () => {
  let rolConsulta;
  let usuarioConsulta;

  beforeAll(async () => {
    rolConsulta = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'consulta' } });
    usuarioConsulta = await prisma.usuario.upsert({
      where: { email: 'rbac-test@medibox.local' },
      update: {},
      create: {
        nombre: 'RBAC Test',
        email: 'rbac-test@medibox.local',
        passwordHash: await bcrypt.hash('x', 12),
        rolId: rolConsulta.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.usuario.delete({ where: { id: usuarioConsulta.id } });
    await prisma.$disconnect();
  });

  it('blocks a consulta-role user from a paciente.read-gated route with 403', async () => {
    const agent = request.agent(buildTestApp());
    await agent.post(`/fake-login/${usuarioConsulta.id}`);
    const res = await agent.get('/solo-pacientes');
    expect(res.status).toBe(403);
  });
});
