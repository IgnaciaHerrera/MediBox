const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { cifrarPaciente } = require('../../src/services/pacienteService');
const { loginAgent } = require('../helpers/csrf');

describe('POST /api/medicos', () => {
  let usuarioAdmin;
  let usuarioMedico;
  let especialidad;
  const password = 'Password123!';

  beforeAll(async () => {
    especialidad = await prisma.especialidad.upsert({ where: { nombre: 'Neurología' }, update: {}, create: { nombre: 'Neurología' } });
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    const rolMedico = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'medico' } });
    usuarioAdmin = await prisma.usuario.upsert({
      where: { email: 'medico-admin-test@medibox.local' },
      update: {},
      create: { nombre: 'Admin Test', email: 'medico-admin-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolAdmin.id },
    });
    usuarioMedico = await prisma.usuario.upsert({
      where: { email: 'medico-user-test@medibox.local' },
      update: {},
      create: { nombre: 'Medico Test', email: 'medico-user-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolMedico.id },
    });
  });

  afterAll(async () => {
    await prisma.cita.deleteMany({ where: { medico: { nombre: 'Dr. Con Citas Test' } } });
    // Limpieza defensiva: borra cualquier médico que este archivo haya creado
    // en esta corrida o en una anterior interrumpida (Medico.nombre no es
    // único, así que sin esto se acumula silenciosamente en cada corrida).
    await prisma.medico.deleteMany({
      where: { nombre: { in: ['Dr. Rechazado', 'Dr. Aceptado', 'Dr. Aceptado Editado', 'Dr. Con Citas Test', 'Dr. Para Eliminar Test'] } },
    });
    await prisma.auditLog.deleteMany({ where: { usuarioId: { in: [usuarioAdmin.id, usuarioMedico.id] } } });
    await prisma.usuario.deleteMany({ where: { id: { in: [usuarioAdmin.id, usuarioMedico.id] } } });
    await prisma.$disconnect();
  });

  it('rejects creation from a non-admin role with 403', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'medico-user-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/medicos').send({ nombre: 'Dr. Rechazado', especialidadId: especialidad.id });
    expect(res.status).toBe(403);
  });

  it('allows creation from an admin role and returns 201', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'medico-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/api/medicos').send({ nombre: 'Dr. Aceptado', especialidadId: especialidad.id });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Dr. Aceptado');
  });

  it('allows an admin to update a medico, including linking a usuario account', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'medico-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const createRes = await agent.post('/api/medicos').send({ nombre: 'Dr. Aceptado', especialidadId: especialidad.id });
    const updateRes = await agent.patch(`/api/medicos/${createRes.body.id}`).send({
      nombre: 'Dr. Aceptado Editado',
      especialidadId: especialidad.id,
      usuarioId: usuarioMedico.id,
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.nombre).toBe('Dr. Aceptado Editado');
    expect(updateRes.body.usuarioId).toBe(usuarioMedico.id);
  });

  it('rejects deleting a medico with citas (even anuladas), and allows it once history-free', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'medico-admin-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const conCitasRes = await agent.post('/api/medicos').send({ nombre: 'Dr. Con Citas Test', especialidadId: especialidad.id });
    const pasillo = await prisma.pasillo.upsert({ where: { nombre: 'Pasillo Medicos Test' }, update: {}, create: { nombre: 'Pasillo Medicos Test' } });
    const box = await prisma.box.upsert({
      where: { pasilloId_nombre: { pasilloId: pasillo.id, nombre: 'Box Medicos Test' } },
      update: {},
      create: { nombre: 'Box Medicos Test', pasilloId: pasillo.id },
    });
    const paciente = await prisma.paciente.create({
      data: {
        ...cifrarPaciente({ nombre: 'Paciente Medicos Test', rut: '14141414-3', contacto: '+56900000001', motivoConsulta: 'Test' }),
        fechaNacimiento: new Date('1990-01-01'),
      },
    });

    const citaRes = await agent.post('/api/citas').send({
      pacienteId: paciente.id, medicoId: conCitasRes.body.id, boxId: box.id, fecha: '2027-06-01', horaInicio: '09:00', horaFin: '10:00',
    });
    expect(citaRes.status).toBe(201);
    await agent.delete(`/api/citas/${citaRes.body.id}`);

    const bloqueado = await agent.delete(`/api/medicos/${conCitasRes.body.id}`);
    expect(bloqueado.status).toBe(400);

    const sinCitasRes = await agent.post('/api/medicos').send({ nombre: 'Dr. Para Eliminar Test', especialidadId: especialidad.id });
    const permitido = await agent.delete(`/api/medicos/${sinCitasRes.body.id}`);
    expect(permitido.status).toBe(204);

    await prisma.cita.deleteMany({ where: { medicoId: conCitasRes.body.id } });
    await prisma.medico.delete({ where: { id: conCitasRes.body.id } });
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.instrumento.deleteMany({ where: { boxId: box.id } });
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.pasillo.delete({ where: { id: pasillo.id } });
  });
});
