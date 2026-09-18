const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');
const { AppError } = require('../lib/AppError');

const MAX_INTENTOS_SERIALIZACION = 3;

async function verificarConflicto({ boxId, medicoId, fecha, horaInicio, horaFin }) {
  const conflicto = await prisma.cita.findFirst({
    where: {
      anulada: false,
      fecha: new Date(fecha),
      horaInicio: { lt: horaFin },
      horaFin: { gt: horaInicio },
      OR: [{ boxId }, { medicoId }],
    },
  });
  return Boolean(conflicto);
}

async function crearCita(datos, usuarioId) {
  const { pacienteId, medicoId, boxId, fecha, horaInicio, horaFin } = datos;

  for (let intento = 1; intento <= MAX_INTENTOS_SERIALIZACION; intento += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const conflicto = await tx.cita.findFirst({
            where: {
              anulada: false,
              fecha: new Date(fecha),
              horaInicio: { lt: horaFin },
              horaFin: { gt: horaInicio },
              OR: [{ boxId }, { medicoId }],
            },
          });
          if (conflicto) {
            throw new AppError('Conflicto de horario para el box o el médico seleccionado', 409);
          }

          const cita = await tx.cita.create({
            data: { pacienteId, medicoId, boxId, fecha: new Date(fecha), horaInicio, horaFin, estado: 'agendada', updatedById: usuarioId },
          });

          await registrar({ usuarioId, accion: 'CREATE', entidad: 'Cita', entidadId: cita.id }, tx);
          return cita;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      const esFalloSerializacion = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
      if (esFalloSerializacion && intento < MAX_INTENTOS_SERIALIZACION) {
        continue;
      }
      throw err;
    }
  }

  // Inalcanzable: el bucle siempre retorna o lanza dentro del try/catch.
  throw new AppError('No se pudo agendar la cita por alta contención, intente nuevamente', 500);
}

async function actualizarEstadoCita(citaId, nuevoEstado, usuarioId) {
  const cita = await prisma.cita.findUnique({ where: { id: citaId } });
  if (!cita || cita.anulada) throw new AppError('Cita no encontrada', 404);

  return prisma.$transaction(async (tx) => {
    const actualizada = await tx.cita.update({
      where: { id: citaId },
      data: { estado: nuevoEstado, updatedById: usuarioId },
    });

    await registrar({ usuarioId, accion: 'UPDATE_ESTADO', entidad: 'Cita', entidadId: citaId }, tx);
    return actualizada;
  });
}

async function anularCita(citaId, usuarioId) {
  const cita = await prisma.cita.findUnique({ where: { id: citaId } });
  if (!cita || cita.anulada) throw new AppError('Cita no encontrada', 404);

  return prisma.$transaction(async (tx) => {
    const anulada = await tx.cita.update({
      where: { id: citaId },
      data: { anulada: true, updatedById: usuarioId },
    });

    await registrar({ usuarioId, accion: 'ANULAR', entidad: 'Cita', entidadId: citaId }, tx);
    return anulada;
  });
}

async function listarCitas({ boxId, medicoId, fecha, page = 1, pageSize = 20 } = {}) {
  const where = {
    anulada: false,
    ...(boxId ? { boxId: Number(boxId) } : {}),
    ...(medicoId ? { medicoId: Number(medicoId) } : {}),
    ...(fecha ? { fecha: new Date(fecha) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.cita.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { horaInicio: 'asc' } }),
    prisma.cita.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

module.exports = { verificarConflicto, crearCita, actualizarEstadoCita, anularCita, listarCitas };
