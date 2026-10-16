const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { cifrarPaciente } = require('../../src/services/pacienteService');

// Modelo de mínimo privilegio del Hito 2: el médico lee solo a los pacientes
// que atiende y registra el estado solo de sus citas; el admin y el gestor no
// leen la identidad de los pacientes.
describe('RBAC de mínimo privilegio', () => {
  const password = 'Password123!';
  const usuarios = {};
  let especialidad;
  let pasillo;
  let box;
  let medicoPropio;
  let medicoAjeno;
  let pacientePropio;
  let pacienteAjeno;
  let citaPropia;
  let citaAjena;

  async function crearUsuario(clave, rolNombre) {
    const rol = await prisma.rol.findUniqueOrThrow({ where: { nombre: rolNombre } });
    const email = `rbac-mp-${clave}@medibox.local`;
    usuarios[clave] = await prisma.usuario.upsert({
      where: { email },
      update: {},
      create: { nombre: `RBAC ${clave}`, email, passwordHash: await bcrypt.hash(password, 12), rolId: rol.id },
    });
  }

  function login(clave) {
    return loginAgent(app, { email: usuarios[clave].email, password }).then(({ agent }) => agent);
  }

  beforeAll(async () => {
    await crearUsuario('medico', 'medico');
    await crearUsuario('admin', 'admin');
    await crearUsuario('gestor', 'gestor');

    especialidad = await prisma.especialidad.upsert({ where: { nombre: 'Especialidad RBAC Test' }, update: {}, create: { nombre: 'Especialidad RBAC Test' } });
    pasillo = await prisma.pasillo.upsert({ where: { nombre: 'Pasillo RBAC Test' }, update: {}, create: { nombre: 'Pasillo RBAC Test' } });
    box = await prisma.box.create({ data: { nombre: 'Box RBAC Test', pasilloId: pasillo.id } });
    medicoPropio = await prisma.medico.create({ data: { nombre: 'Dr. Propio RBAC Test', especialidadId: especialidad.id, usuarioId: usuarios.medico.id } });
    medicoAjeno = await prisma.medico.create({ data: { nombre: 'Dr. Ajeno RBAC Test', especialidadId: especialidad.id } });

    pacientePropio = await prisma.paciente.create({
      data: cifrarPaciente({ nombre: 'Paciente Propio RBAC', rut: '21212121-5', fechaNacimiento: '1980-01-01' }),
    });
    pacienteAjeno = await prisma.paciente.create({
      data: cifrarPaciente({ nombre: 'Paciente Ajeno RBAC', rut: '23232323-K', fechaNacimiento: '1981-01-01' }),
    });
    const base = { boxId: box.id, fecha: new Date('2031-01-15'), horaFin: '10:00' };
    citaPropia = await prisma.cita.create({ data: { ...base, pacienteId: pacientePropio.id, medicoId: medicoPropio.id, horaInicio: '09:00', horaFin: '09:30' } });
    citaAjena = await prisma.cita.create({ data: { ...base, pacienteId: pacienteAjeno.id, medicoId: medicoAjeno.id, horaInicio: '09:30' } });
  });

  afterAll(async () => {
    const ids = Object.values(usuarios).map((u) => u.id);
    await prisma.cita.deleteMany({ where: { boxId: box.id } });
    await prisma.paciente.deleteMany({ where: { id: { in: [pacientePropio.id, pacienteAjeno.id] } } });
    await prisma.medico.deleteMany({ where: { id: { in: [medicoPropio.id, medicoAjeno.id] } } });
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.pasillo.delete({ where: { id: pasillo.id } });
    await prisma.especialidad.delete({ where: { id: especialidad.id } });
    await prisma.auditLog.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('el médico lista y abre solo a los pacientes que atiende', async () => {
    const agent = await login('medico');

    const lista = await agent.get('/api/pacientes');
    expect(lista.status).toBe(200);
    const ids = lista.body.items.map((p) => p.id);
    expect(ids).toContain(pacientePropio.id);
    expect(ids).not.toContain(pacienteAjeno.id);

    expect((await agent.get(`/api/pacientes/${pacientePropio.id}`)).status).toBe(200);
    // Fuera de su alcance responde como inexistente: no revela que existe.
    expect((await agent.get(`/api/pacientes/${pacienteAjeno.id}`)).status).toBe(404);
    expect((await agent.get(`/pacientes/${pacienteAjeno.id}`)).status).toBe(404);

    const porRutAjeno = await agent.get('/api/pacientes').query({ q: '23.232.323-K' });
    expect(porRutAjeno.body.items).toEqual([]);
  });

  it('el médico ve la agenda completa, pero la identidad solo en sus citas', async () => {
    const agent = await login('medico');

    const propia = await agent.get(`/agenda/${citaPropia.id}`);
    expect(propia.status).toBe(200);
    expect(propia.text).toContain('Paciente Propio RBAC');

    const ajena = await agent.get(`/agenda/${citaAjena.id}`);
    expect(ajena.status).toBe(200);
    expect(ajena.text).not.toContain('Paciente Ajeno RBAC');
    expect(ajena.text).not.toContain('Marcar atendido');
  });

  it('el médico registra la atención de sus citas, no de las ajenas, y no anula', async () => {
    const agent = await login('medico');

    const propia = await agent.patch(`/api/citas/${citaPropia.id}/estado`).send({ estado: 'atendido' });
    expect(propia.status).toBe(200);
    expect(propia.body.estado).toBe('atendido');

    const ajena = await agent.patch(`/api/citas/${citaAjena.id}/estado`).send({ estado: 'atendido' });
    expect(ajena.status).toBe(404);
    const sinCambio = await prisma.cita.findUnique({ where: { id: citaAjena.id } });
    expect(sinCambio.estado).toBe('agendada');

    expect((await agent.delete(`/api/citas/${citaPropia.id}`)).status).toBe(403);
  });

  it('el admin administra cuentas y roles, pero no lee pacientes ni la auditoría', async () => {
    const agent = await login('admin');
    expect((await agent.get('/api/usuarios')).status).toBe(200);
    expect((await agent.get('/api/pacientes')).status).toBe(403);
    expect((await agent.get(`/pacientes/${pacientePropio.id}`)).status).toBe(403);
    expect((await agent.get('/api/auditoria')).status).toBe(403);
  });

  it('el gestor audita y exporta, pero no lee pacientes ni agenda citas', async () => {
    const agent = await login('gestor');
    expect((await agent.get('/api/auditoria')).status).toBe(200);
    expect((await agent.get('/api/pacientes')).status).toBe(403);
    expect((await agent.get('/agenda/nueva')).status).toBe(403);
    const detalle = await agent.get(`/agenda/${citaPropia.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.text).not.toContain('Paciente Propio RBAC');
  });
});
