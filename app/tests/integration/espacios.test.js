const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { cifrarPaciente } = require('../../src/services/pacienteService');
const { loginAgent } = require('../helpers/csrf');

describe('Espacios físicos', () => {
  let usuarioGestor;
  let pasillo;
  const password = 'Password123!';

  const NOMBRE_PASILLO = 'Pasillo Espacios Test';

  beforeAll(async () => {
    // Defensivo: si una corrida anterior quedó interrumpida antes de su
    // afterAll, no debe romper esta corrida (mismo patrón que citas.test.js).
    await prisma.instrumento.deleteMany({ where: { box: { nombre: 'Box 99' } } });
    await prisma.box.deleteMany({ where: { nombre: 'Box 99' } });

    // Pasillo exclusivo de este test — nunca "Pasillo A", que es un pasillo
    // real de datos de demo (seed.js) con sus propios boxes encima.
    pasillo = await prisma.pasillo.upsert({ where: { nombre: NOMBRE_PASILLO }, update: {}, create: { nombre: NOMBRE_PASILLO } });
    const rolGestor = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'gestor' } });
    usuarioGestor = await prisma.usuario.upsert({
      where: { email: 'espacios-test@medibox.local' },
      update: {},
      create: { nombre: 'Gestor Test', email: 'espacios-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolGestor.id },
    });
  });

  afterAll(async () => {
    await prisma.cita.deleteMany({ where: { box: { nombre: 'Box Con Citas Test' } } });
    await prisma.instrumento.deleteMany({
      where: { box: { nombre: { in: ['Box 99', 'Box 100', 'Box 101', 'Box Con Citas Test', 'Box Para Eliminar Test'] } } },
    });
    await prisma.box.deleteMany({ where: { nombre: { in: ['Box 99', 'Box 100', 'Box 101', 'Box Con Citas Test', 'Box Para Eliminar Test'] } } });
    await prisma.pasillo.deleteMany({
      where: { nombre: { in: [NOMBRE_PASILLO, 'Pasillo Nuevo Test', 'Pasillo Duplicado Test', 'Pasillo Renombrado Test', 'Pasillo Vacio Test'] } },
    });
    await prisma.auditLog.deleteMany({ where: { usuarioId: usuarioGestor.id } });
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

  it('creates a new pasillo', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/pasillos').send({ nombre: 'Pasillo Nuevo Test' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Pasillo Nuevo Test');
  });

  it('updates a box name and returns the updated row', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const boxRes = await agent.post('/api/boxes').send({ nombre: 'Box 100', pasilloId: pasillo.id });
    const updateRes = await agent.patch(`/api/boxes/${boxRes.body.id}`).send({ nombre: 'Box 100', pasilloId: pasillo.id });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.nombre).toBe('Box 100');
  });

  it('deletes an instrument from a box', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const boxRes = await agent.post('/api/boxes').send({ nombre: 'Box 101', pasilloId: pasillo.id });
    const instrumentoRes = await agent.post(`/api/boxes/${boxRes.body.id}/instrumentos`).send({ nombre: 'Camilla' });

    const deleteRes = await agent.delete(`/api/boxes/${boxRes.body.id}/instrumentos/${instrumentoRes.body.id}`);
    expect(deleteRes.status).toBe(204);

    const listRes = await agent.get(`/api/boxes/${boxRes.body.id}/instrumentos`);
    expect(listRes.body).toEqual([]);
  });

  it('rejects creating a duplicate box name within the same pasillo with 409', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.post('/api/boxes').send({ nombre: 'Box 99', pasilloId: pasillo.id });
    expect(res.status).toBe(409);
  });

  it('renames a pasillo and rejects a duplicate name', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const renombrar = await agent.patch(`/api/pasillos/${pasillo.id}`).send({ nombre: 'Pasillo Renombrado Test' });
    expect(renombrar.status).toBe(200);
    expect(renombrar.body.nombre).toBe('Pasillo Renombrado Test');

    // Deja el pasillo como estaba para no romper el resto de los tests de este archivo.
    await agent.patch(`/api/pasillos/${pasillo.id}`).send({ nombre: NOMBRE_PASILLO });

    const otroRes = await agent.post('/api/pasillos').send({ nombre: 'Pasillo Duplicado Test' });
    expect(otroRes.status).toBe(201);
    const duplicado = await agent.patch(`/api/pasillos/${pasillo.id}`).send({ nombre: otroRes.body.nombre });
    expect(duplicado.status).toBe(409);
  });

  it('rejects deleting a pasillo that still has boxes, and allows it once empty', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const conBoxes = await agent.delete(`/api/pasillos/${pasillo.id}`);
    expect(conBoxes.status).toBe(400);

    const vacio = await agent.post('/api/pasillos').send({ nombre: 'Pasillo Vacio Test' });
    const eliminar = await agent.delete(`/api/pasillos/${vacio.body.id}`);
    expect(eliminar.status).toBe(204);
  });

  it('rejects deleting a box with citas (even anuladas), and allows it once history-free', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'espacios-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const especialidad = await prisma.especialidad.upsert({ where: { nombre: 'Especialidad Espacios Test' }, update: {}, create: { nombre: 'Especialidad Espacios Test' } });
    const medico = await prisma.medico.create({ data: { nombre: 'Dr. Espacios Test', especialidadId: especialidad.id } });
    const paciente = await prisma.paciente.create({
      data: {
        ...cifrarPaciente({ nombre: 'Paciente Espacios Test', rut: '13131313-6', contacto: '+56900000000', motivoConsulta: 'Test' }),
        fechaNacimiento: new Date('1990-01-01'),
      },
    });

    const boxConCitasRes = await agent.post('/api/boxes').send({ nombre: 'Box Con Citas Test', pasilloId: pasillo.id });
    const citaRes = await agent.post('/api/citas').send({
      pacienteId: paciente.id, medicoId: medico.id, boxId: boxConCitasRes.body.id, fecha: '2027-05-01', horaInicio: '09:00', horaFin: '10:00',
    });
    expect(citaRes.status).toBe(201);
    await agent.delete(`/api/citas/${citaRes.body.id}`); // se anula, pero la fila de historial sigue existiendo

    const bloqueado = await agent.delete(`/api/boxes/${boxConCitasRes.body.id}`);
    expect(bloqueado.status).toBe(400);

    const boxVacioRes = await agent.post('/api/boxes').send({ nombre: 'Box Para Eliminar Test', pasilloId: pasillo.id });
    const permitido = await agent.delete(`/api/boxes/${boxVacioRes.body.id}`);
    expect(permitido.status).toBe(204);

    await prisma.cita.deleteMany({ where: { boxId: boxConCitasRes.body.id } });
    await prisma.box.delete({ where: { id: boxConCitasRes.body.id } });
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.medico.delete({ where: { id: medico.id } });
    await prisma.especialidad.delete({ where: { id: especialidad.id } });
  });
});
