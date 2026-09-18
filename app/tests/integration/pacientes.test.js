const bcrypt = require('bcrypt');
const { Prisma } = require('@prisma/client');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

describe('Paciente encryption and access control', () => {
  let usuarioOperador;
  let usuarioConsulta;
  const password = 'Password123!';
  const pacienteIds = [];

  beforeAll(async () => {
    const rolOperador = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'operador' } });
    const rolConsulta = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'consulta' } });
    usuarioOperador = await prisma.usuario.upsert({
      where: { email: 'paciente-operador-test@medibox.local' },
      update: {},
      create: { nombre: 'Operador Test', email: 'paciente-operador-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolOperador.id },
    });
    usuarioConsulta = await prisma.usuario.upsert({
      where: { email: 'paciente-consulta-test@medibox.local' },
      update: {},
      create: { nombre: 'Consulta Test', email: 'paciente-consulta-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolConsulta.id },
    });
  });

  afterAll(async () => {
    if (pacienteIds.length > 0) {
      await prisma.$executeRaw`DELETE FROM pacientes WHERE id IN (${Prisma.join(pacienteIds)})`;
    }
    await prisma.auditLog.deleteMany({ where: { usuarioId: { in: [usuarioOperador.id, usuarioConsulta.id] } } });
    await prisma.usuario.deleteMany({ where: { id: { in: [usuarioOperador.id, usuarioConsulta.id] } } });
    await prisma.$disconnect();
  });

  it('stores rut and motivo_consulta encrypted at rest (raw column is not plaintext)', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'Juan Pérez',
      rut: '12345678-9',
      fechaNacimiento: '1990-05-20',
      contacto: '+56911112222',
      motivoConsulta: 'Control cardiológico',
    });
    expect(createRes.status).toBe(201);
    pacienteIds.push(createRes.body.id);

    const rawRows = await prisma.$queryRaw`SELECT rut_cifrado, motivo_consulta_cifrado FROM pacientes WHERE id = ${createRes.body.id}`;
    const rawBuffer = rawRows[0].rut_cifrado;
    expect(Buffer.isBuffer(rawBuffer)).toBe(true);
    expect(rawBuffer.toString('utf8')).not.toContain('12345678-9');
  });

  it('decrypts rut and motivo_consulta for an authorized read and writes an audit row', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'María Soto',
      rut: '98765432-1',
      fechaNacimiento: '1985-02-10',
      contacto: '+56933334444',
      motivoConsulta: 'Chequeo dermatológico',
    });
    pacienteIds.push(createRes.body.id);

    const readRes = await agent.get(`/api/pacientes/${createRes.body.id}`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.rut).toBe('98765432-1');
    expect(readRes.body.motivoConsulta).toBe('Chequeo dermatológico');

    const auditRows = await prisma.auditLog.findMany({ where: { entidad: 'Paciente', entidadId: createRes.body.id, accion: 'READ' } });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a consulta-role user from reading patient data with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-consulta-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/pacientes');
    expect(res.status).toBe(403);
  });
});
