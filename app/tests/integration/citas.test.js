const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { registrar } = require('../../src/services/auditService');
const { loginAgent } = require('../helpers/csrf');

describe('Agenda: conflict prevention and soft delete', () => {
  let usuarioOperador;
  let usuarioMedicoNotif;
  let medico;
  let box;
  let pasillo;
  const password = 'Password123!';
  const pacienteIds = [];

  beforeAll(async () => {
    const rolOperador = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'operador' } });
    usuarioOperador = await prisma.usuario.upsert({
      where: { email: 'citas-test@medibox.local' },
      update: {},
      create: { nombre: 'Operador Citas', email: 'citas-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolOperador.id },
    });
    const especialidad = await prisma.especialidad.upsert({ where: { nombre: 'Traumatología' }, update: {}, create: { nombre: 'Traumatología' } });
    // Medico no tiene un campo único natural (solo `id` autoincremental), así que
    // se busca por (nombre, especialidadId) y se crea solo si no existe, en vez de
    // `create` a secas — así una fila huérfana de una corrida anterior interrumpida
    // (que no llegó a su `afterAll`) se reutiliza en vez de romper corridas futuras.
    medico = await prisma.medico.findFirst({ where: { nombre: 'Dr. Test Citas', especialidadId: especialidad.id } });
    if (!medico) {
      medico = await prisma.medico.create({ data: { nombre: 'Dr. Test Citas', especialidadId: especialidad.id } });
    }
    pasillo = await prisma.pasillo.upsert({ where: { nombre: 'Pasillo Citas' }, update: {}, create: { nombre: 'Pasillo Citas' } });
    // Igual que arriba: Box sí tiene un unique compuesto (pasilloId, nombre), así que
    // se puede usar upsert directamente para tolerar una fila huérfana preexistente.
    box = await prisma.box.upsert({
      where: { pasilloId_nombre: { pasilloId: pasillo.id, nombre: 'Box Citas' } },
      update: {},
      create: { nombre: 'Box Citas', pasilloId: pasillo.id },
    });
    // Limpieza defensiva de entrada, espejo de la que hace `afterAll` al salir:
    // si una corrida anterior fue interrumpida DESPUÉS de crear al menos una
    // Cita en este box (no solo antes, como cubre el upsert/findFirst de arriba),
    // esa Cita huérfana con `anulada: false` chocaría con las fechas/horas
    // hardcodeadas de los tests de abajo y `crearCita` devolvería 409 en vez de
    // 201 de forma permanente hasta limpiarla a mano. Corriendo esto al inicio,
    // el box queda en un estado limpio sin importar en qué punto se haya
    // interrumpido la corrida previa.
    await prisma.cita.deleteMany({ where: { boxId: box.id } });
  });

  afterAll(async () => {
    await prisma.cita.deleteMany({ where: { boxId: box.id } });
    if (pacienteIds.length > 0) {
      await prisma.paciente.deleteMany({ where: { id: { in: pacienteIds } } });
    }
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.medico.update({ where: { id: medico.id }, data: { usuarioId: null } });
    await prisma.medico.delete({ where: { id: medico.id } });
    await prisma.auditLog.deleteMany({ where: { usuarioId: usuarioOperador.id } });
    await prisma.usuario.delete({ where: { id: usuarioOperador.id } });
    if (usuarioMedicoNotif) {
      await prisma.notificacion.deleteMany({ where: { usuarioId: usuarioMedicoNotif.id } });
      await prisma.usuario.delete({ where: { id: usuarioMedicoNotif.id } });
    }
    await prisma.$disconnect();
  });

  async function login() {
    const { agent, loginRes } = await loginAgent(app, { email: 'citas-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    return agent;
  }

  it('creates a paciente and a cita for it', async () => {
    const agent = await login();
    const pacienteRes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Agenda', rut: '11222333-9', fechaNacimiento: '1995-01-01', contacto: '+56900001111', motivoConsulta: 'Dolor de rodilla',
    });
    pacienteIds.push(pacienteRes.body.id);

    const citaRes = await agent.post('/api/citas').send({
      pacienteId: pacienteRes.body.id, medicoId: medico.id, boxId: box.id, fecha: '2026-11-01', horaInicio: '09:00', horaFin: '10:00',
    });
    expect(citaRes.status).toBe(201);
  });

  it('GET /api/citas/conflicto reports true for an overlapping slot and false otherwise', async () => {
    const agent = await login();

    const solapada = await agent.get('/api/citas/conflicto').query({
      medicoId: medico.id, boxId: box.id, fecha: '2026-11-01', horaInicio: '09:30', horaFin: '10:30',
    });
    expect(solapada.status).toBe(200);
    expect(solapada.body).toEqual({ conflicto: true });

    const libre = await agent.get('/api/citas/conflicto').query({
      medicoId: medico.id, boxId: box.id, fecha: '2026-11-01', horaInicio: '11:00', horaFin: '12:00',
    });
    expect(libre.status).toBe(200);
    expect(libre.body).toEqual({ conflicto: false });
  });

  it('GET /api/citas?pasilloId filters by the box\'s pasillo', async () => {
    const agent = await login();
    const otroPasillo = await prisma.pasillo.upsert({ where: { nombre: 'Pasillo Citas Otro' }, update: {}, create: { nombre: 'Pasillo Citas Otro' } });

    const conElPasillo = await agent.get('/api/citas').query({ fecha: '2026-11-01', pasilloId: pasillo.id });
    expect(conElPasillo.status).toBe(200);
    expect(conElPasillo.body.items.some((c) => c.boxId === box.id)).toBe(true);

    const conOtroPasillo = await agent.get('/api/citas').query({ fecha: '2026-11-01', pasilloId: otroPasillo.id });
    expect(conOtroPasillo.status).toBe(200);
    expect(conOtroPasillo.body.items.some((c) => c.boxId === box.id)).toBe(false);

    await prisma.pasillo.delete({ where: { id: otroPasillo.id } });
  });

  it('rejects a second cita that overlaps the same box and time with 409', async () => {
    const agent = await login();
    const pacienteRes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Conflicto', rut: '55666777-2', fechaNacimiento: '1992-03-03', contacto: '+56900002222', motivoConsulta: 'Control',
    });
    pacienteIds.push(pacienteRes.body.id);

    const conflictoRes = await agent.post('/api/citas').send({
      pacienteId: pacienteRes.body.id, medicoId: medico.id, boxId: box.id, fecha: '2026-11-01', horaInicio: '09:30', horaFin: '10:30',
    });
    expect(conflictoRes.status).toBe(409);
  });

  it('soft-deletes a cita instead of removing the row', async () => {
    const agent = await login();
    const pacienteRes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Anular', rut: '99888777-1', fechaNacimiento: '1988-07-07', contacto: '+56900003333', motivoConsulta: 'Revisión',
    });
    pacienteIds.push(pacienteRes.body.id);

    const citaRes = await agent.post('/api/citas').send({
      pacienteId: pacienteRes.body.id, medicoId: medico.id, boxId: box.id, fecha: '2026-12-01', horaInicio: '14:00', horaFin: '15:00',
    });

    const anularRes = await agent.delete(`/api/citas/${citaRes.body.id}`);
    expect(anularRes.status).toBe(200);

    const rowInDb = await prisma.cita.findUnique({ where: { id: citaRes.body.id } });
    expect(rowInDb).not.toBeNull();
    expect(rowInDb.anulada).toBe(true);
  });

  // Mejor esfuerzo: dispara dos POST /api/citas concurrentes para el mismo box/horario
  // y verifica que la transacción Serializable + reintento acotado de crearCita
  // deja pasar exactamente una. Puede ser sensible al timing de la BD real.
  it('allows only one of two concurrent overlapping requests to succeed', async () => {
    const agent = await login();
    const pacienteARes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Concurrencia A', rut: '10101010-4', fechaNacimiento: '1990-01-01', contacto: '+56900004444', motivoConsulta: 'Consulta A',
    });
    pacienteIds.push(pacienteARes.body.id);
    const pacienteBRes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Concurrencia B', rut: '20202020-8', fechaNacimiento: '1991-02-02', contacto: '+56900005555', motivoConsulta: 'Consulta B',
    });
    pacienteIds.push(pacienteBRes.body.id);

    const base = { medicoId: medico.id, boxId: box.id, fecha: '2026-12-15', horaInicio: '16:00', horaFin: '17:00' };
    const [resA, resB] = await Promise.all([
      agent.post('/api/citas').send({ ...base, pacienteId: pacienteARes.body.id }),
      agent.post('/api/citas').send({ ...base, pacienteId: pacienteBRes.body.id }),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(201);
    // El perdedor de la carrera debe recibir 409 (conflicto detectado) o, en el peor
    // caso de alta contención tras agotar los reintentos de serialización, 500.
    expect([409, 500]).toContain(statuses[1]);

    const citasCreadas = await prisma.cita.count({
      where: { boxId: box.id, fecha: new Date('2026-12-15'), anulada: false },
    });
    expect(citasCreadas).toBe(1);
  });

  // Verificación dirigida y determinista del fix post-revisión: registrar(...) dentro de la
  // transacción de crearCita debe usar el cliente `tx`, no el `prisma` global, para que la
  // fila de AuditLog participe de la misma atomicidad que el INSERT de la cita. Forzar un
  // P2034 real requiere una colisión de serialización genuina entre dos transacciones
  // concurrentes (no determinista); en cambio, esta prueba fuerza el abort de la transacción
  // de forma determinista y verifica la garantía subyacente que el fix explota: si la
  // transacción aborta por CUALQUIER motivo (P2034 incluido), tanto el INSERT de la cita
  // como el registro de auditoría hecho con `registrar(..., tx)` se revierten juntos —
  // no queda ninguna fila de AuditLog huérfana apuntando a una cita que nunca se creó.
  it('rolls back the audit row together with the cita insert when the transaction aborts (no orphaned AuditLog row)', async () => {
    const agent = await login();
    const pacienteRes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Rollback Auditoria', rut: '30303030-1', fechaNacimiento: '1993-03-03', contacto: '+56900006666', motivoConsulta: 'Consulta rollback',
    });
    pacienteIds.push(pacienteRes.body.id);

    let citaIdDentroDeTx;

    await expect(
      prisma.$transaction(async (tx) => {
        const cita = await tx.cita.create({
          data: {
            pacienteId: pacienteRes.body.id,
            medicoId: medico.id,
            boxId: box.id,
            fecha: new Date('2027-01-10'),
            horaInicio: '08:00',
            horaFin: '09:00',
            estado: 'agendada',
            updatedById: usuarioOperador.id,
          },
        });
        citaIdDentroDeTx = cita.id;

        await registrar({ usuarioId: usuarioOperador.id, accion: 'CREATE', entidad: 'Cita', entidadId: cita.id }, tx);

        throw new Error('Abort forzado para simular un fallo de serializacion (P2034) dentro de la transaccion');
      }),
    ).rejects.toThrow('Abort forzado');

    const citaEnBd = await prisma.cita.findUnique({ where: { id: citaIdDentroDeTx } });
    expect(citaEnBd).toBeNull();

    const auditRowsHuerfanas = await prisma.auditLog.findMany({ where: { entidad: 'Cita', entidadId: citaIdDentroDeTx } });
    expect(auditRowsHuerfanas).toHaveLength(0);
  });

  it('notifies the linked medico usuario when a cita is created and again when it is anulada', async () => {
    const rolMedico = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'medico' } });
    usuarioMedicoNotif = await prisma.usuario.upsert({
      where: { email: 'citas-notif-medico-test@medibox.local' },
      update: {},
      create: { nombre: 'Medico Notif Test', email: 'citas-notif-medico-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolMedico.id },
    });
    await prisma.medico.update({ where: { id: medico.id }, data: { usuarioId: usuarioMedicoNotif.id } });

    const agent = await login();
    const pacienteRes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Notificacion', rut: '40404040-5', fechaNacimiento: '1994-04-04', contacto: '+56900007777', motivoConsulta: 'Consulta con notificación',
    });
    pacienteIds.push(pacienteRes.body.id);

    const citaRes = await agent.post('/api/citas').send({
      pacienteId: pacienteRes.body.id, medicoId: medico.id, boxId: box.id, fecha: '2027-02-01', horaInicio: '11:00', horaFin: '12:00',
    });
    expect(citaRes.status).toBe(201);

    const notifsTrasCrear = await prisma.notificacion.findMany({ where: { usuarioId: usuarioMedicoNotif.id } });
    expect(notifsTrasCrear.length).toBe(1);
    expect(notifsTrasCrear[0].mensaje).toMatch(/Nueva cita agendada/);

    await agent.delete(`/api/citas/${citaRes.body.id}`);

    const notifsTrasAnular = await prisma.notificacion.findMany({ where: { usuarioId: usuarioMedicoNotif.id } });
    expect(notifsTrasAnular.length).toBe(2);
    expect(notifsTrasAnular.some((n) => /anuló/.test(n.mensaje))).toBe(true);

    await prisma.medico.update({ where: { id: medico.id }, data: { usuarioId: null } });
  });
});
