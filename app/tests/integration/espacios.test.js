const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('Espacios físicos', () => {
  let usuarioGestor;
  let pasillo;
  const password = 'Password123!';

  beforeAll(async () => {
    pasillo = await prisma.pasillo.upsert({ where: { nombre: 'Pasillo A' }, update: {}, create: { nombre: 'Pasillo A' } });
    const rolGestor = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'gestor' } });
    usuarioGestor = await prisma.usuario.upsert({
      where: { email: 'espacios-test@medibox.local' },
      update: {},
      create: { nombre: 'Gestor Test', email: 'espacios-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolGestor.id },
    });
  });

  afterAll(async () => {
    await prisma.instrumento.deleteMany({ where: { box: { nombre: 'Box 99' } } });
    await prisma.box.deleteMany({ where: { nombre: 'Box 99' } });
    await prisma.pasillo.deleteMany({ where: { nombre: 'Pasillo A' } });
    await prisma.usuario.delete({ where: { id: usuarioGestor.id } });
    await prisma.$disconnect();
  });

  it('creates a box and then an instrument under it', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const boxRes = await agent.post('/api/boxes').send({ nombre: 'Box 99', pasilloId: pasillo.id });
    expect(boxRes.status).toBe(201);

    const instrumentoRes = await agent.post(`/api/boxes/${boxRes.body.id}/instrumentos`).send({ nombre: 'Tensiómetro' });
    expect(instrumentoRes.status).toBe(201);
    expect(instrumentoRes.body.boxId).toBe(boxRes.body.id);
  });

  it('returns 404 when creating an instrument for a nonexistent box', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/boxes/999999/instrumentos').send({ nombre: 'Fonendoscopio' });
    expect(res.status).toBe(404);
  });
});
