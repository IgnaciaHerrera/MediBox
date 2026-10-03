const bcrypt = require('bcrypt');
const { Prisma } = require('@prisma/client');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { cifrarPaciente } = require('../../src/services/pacienteService');

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

  it('stores nombre, rut and contacto encrypted at rest, with no plaintext column left', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const datos = {
      nombre: 'Juan Pérez',
      rut: '12345678-5',
      fechaNacimiento: '1990-05-20',
      contacto: '+56911112222',
    };
    const createRes = await agent.post('/api/pacientes').send(datos);
    expect(createRes.status).toBe(201);
    pacienteIds.push(createRes.body.id);

    const [fila] = await prisma.$queryRaw`
      SELECT nombre_cifrado, rut_cifrado, contacto_cifrado
      FROM pacientes WHERE id = ${createRes.body.id}
    `;
    const columnas = [
      [fila.nombre_cifrado, datos.nombre],
      [fila.rut_cifrado, datos.rut],
      [fila.contacto_cifrado, datos.contacto],
    ];
    columnas.forEach(([blob, enClaro]) => {
      expect(Buffer.isBuffer(blob)).toBe(true);
      expect(blob[0]).toBe(1); // versión del formato AES-256-GCM
      expect(blob.toString('utf8')).not.toContain(enClaro);
    });

    const columnasTabla = await prisma.$queryRaw`
      SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pacientes'
    `;
    const textoPlano = columnasTabla.filter((c) => c.data_type === 'text').map((c) => c.column_name);
    expect(textoPlano).toEqual([]);
  });

  it('rejects a second patient with the same RUT even when written differently', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const datos = { nombre: 'Duplicado Uno', fechaNacimiento: '1975-03-03', contacto: '+56977778888' };

    const primero = await agent.post('/api/pacientes').send({ ...datos, rut: '16161616-8' });
    expect(primero.status).toBe(201);
    pacienteIds.push(primero.body.id);

    const segundo = await agent.post('/api/pacientes').send({ ...datos, nombre: 'Duplicado Dos', rut: '16.161.616-8' });
    expect(segundo.status).toBe(409);
    expect(segundo.body.error).toMatch(/Ya existe un paciente/);
  });

  it('GET /api/pacientes?q filters by name without exposing rut in the list', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'Zoraida Buscable Test',
      rut: '19222333-4',
      fechaNacimiento: '1988-02-02',
      contacto: '+56933334444',
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

  it('GET /api/pacientes?q finds a patient by full RUT through the blind index', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'Rosa Busqueda Rut',
      rut: '18181818-2',
      fechaNacimiento: '1966-06-06',
      contacto: '+56944445555',
    });
    expect(createRes.status).toBe(201);
    pacienteIds.push(createRes.body.id);

    const porRut = await agent.get('/api/pacientes').query({ q: '18.181.818-2' });
    expect(porRut.status).toBe(200);
    expect(porRut.body.items.map((p) => p.id)).toEqual([createRes.body.id]);
    expect(porRut.body.items[0].nombre).toBe('Rosa Busqueda Rut');

    const rutParcial = await agent.get('/api/pacientes').query({ q: '18181818' });
    expect(rutParcial.body.items.some((p) => p.id === createRes.body.id)).toBe(false);

    // Un paciente migrado puede traer un RUT anterior a la validación del
    // dígito verificador; igual debe poder encontrarse por él.
    const migrado = await prisma.paciente.create({
      data: {
        ...cifrarPaciente({ nombre: 'Paciente Migrado Test', rut: '11111111-2', contacto: '+56912121212' }),
        fechaNacimiento: new Date('1950-01-01'),
      },
    });
    pacienteIds.push(migrado.id);
    const porRutAntiguo = await agent.get('/api/pacientes').query({ q: '11.111.111-2' });
    expect(porRutAntiguo.body.items.map((p) => p.id)).toEqual([migrado.id]);
  });

  it('decrypts rut for an authorized read and writes an audit row', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'María Soto',
      rut: '98765432-5',
      fechaNacimiento: '1985-02-10',
      contacto: '+56933334444',
    });
    pacienteIds.push(createRes.body.id);

    const readRes = await agent.get(`/api/pacientes/${createRes.body.id}`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.rut).toBe('98765432-5');

    const auditRows = await prisma.auditLog.findMany({ where: { entidad: 'Paciente', entidadId: createRes.body.id, accion: 'READ' } });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it('updates rut, re-encrypting it, and audits the update', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/pacientes').send({
      nombre: 'Pedro Original',
      rut: '11111111-1',
      fechaNacimiento: '1970-01-01',
      contacto: '+56900000000',
    });
    pacienteIds.push(createRes.body.id);

    const updateRes = await agent.patch(`/api/pacientes/${createRes.body.id}`).send({
      nombre: 'Pedro Actualizado',
      rut: '22222222-2',
      fechaNacimiento: '1970-01-01',
      contacto: '+56911111111',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.nombre).toBe('Pedro Actualizado');

    const readRes = await agent.get(`/api/pacientes/${createRes.body.id}`);
    expect(readRes.body.rut).toBe('22222222-2');

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
    });
    expect(res.status).toBe(404);
  });

  it('rejects a RUT with a wrong check digit and stores a valid one normalized', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-operador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const datos = { nombre: 'Rut Formato', fechaNacimiento: '1980-08-08', contacto: '+56955556666' };

    const invalido = await agent.post('/api/pacientes').send({ ...datos, rut: '7.654.321-0' });
    expect(invalido.status).toBe(400);
    expect(invalido.body.error).toMatch(/RUT no es válido/);

    const valido = await agent.post('/api/pacientes').send({ ...datos, rut: '7.654.321-6' });
    expect(valido.status).toBe(201);
    pacienteIds.push(valido.body.id);
    const readRes = await agent.get(`/api/pacientes/${valido.body.id}`);
    expect(readRes.body.rut).toBe('7654321-6');
  });

  it('rejects a consulta-role user from reading patient data with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'paciente-consulta-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/pacientes');
    expect(res.status).toBe(403);
  });
});
