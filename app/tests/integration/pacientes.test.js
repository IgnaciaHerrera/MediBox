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

  it('GET /api/pacientes?q filters by name without exposing rut in the list', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'Zoraida Buscable Test',
      rut: '19222333-1',
      fechaNacimiento: '1988-02-02',
      contacto: '+56933334444',
      motivoConsulta: 'Consulta de prueba de búsqueda',
    });
    expect(createRes.status).toBe(201);
    pacienteIds.push(createRes.body.id);

    const conCoincidencia = await agent.get('/api/pacientes').query({ q: 'Zoraida Buscable' });
    expect(conCoincidencia.status).toBe(200);
    expect(conCoincidencia.body.items.some((p) => p.id === createRes.body.id)).toBe(true);
    expect(conCoincidencia.body.items[0].rut).toBeUndefined();

    const sinCoincidencia = await agent.get('/api/pacientes').query({ q: 'NombreQueNoExisteEnNadie' });
    expect(sinCoincidencia.status).toBe(200);
    expect(sinCoincidencia.body.items.some((p) => p.id === createRes.body.id)).toBe(false);
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

  it('updates rut and motivo_consulta, re-encrypting them, and audits the update', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'Pedro Original',
      rut: '11111111-1',
      fechaNacimiento: '1970-01-01',
      contacto: '+56900000000',
      motivoConsulta: 'Motivo original',
    });
    pacienteIds.push(createRes.body.id);

    const updateRes = await agent.patch(`/api/pacientes/${createRes.body.id}`).send({
      nombre: 'Pedro Actualizado',
      rut: '22222222-2',
      fechaNacimiento: '1970-01-01',
      contacto: '+56911111111',
      motivoConsulta: 'Motivo actualizado',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.nombre).toBe('Pedro Actualizado');

    const readRes = await agent.get(`/api/pacientes/${createRes.body.id}`);
    expect(readRes.body.rut).toBe('22222222-2');
    expect(readRes.body.motivoConsulta).toBe('Motivo actualizado');

    const rawRows = await prisma.$queryRaw`SELECT rut_cifrado FROM pacientes WHERE id = ${createRes.body.id}`;
    expect(rawRows[0].rut_cifrado.toString('utf8')).not.toContain('22222222-2');

    const auditRows = await prisma.auditLog.findMany({ where: { entidad: 'Paciente', entidadId: createRes.body.id, accion: 'UPDATE' } });
    expect(auditRows.length).toBe(1);
  });

  it('returns 404 when updating a nonexistent patient', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.patch('/api/pacientes/999999').send({
      nombre: 'Paciente Inexistente',
      rut: '11111111-1',
      fechaNacimiento: '1970-01-01',
      contacto: '+56900000000',
      motivoConsulta: 'Motivo de prueba',
    });
    expect(res.status).toBe(404);
  });

  it('rejects a consulta-role user from reading patient data with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-consulta-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/pacientes');
    expect(res.status).toBe(403);
  });
});
