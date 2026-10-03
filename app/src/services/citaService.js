const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');
const { crearNotificacion } = require('./notificacionService');
const { AppError } = require('../lib/AppError');
const { logger } = require('../lib/logger');

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
      const cita = await prisma.$transaction(
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

          const nuevaCita = await tx.cita.create({
            data: { pacienteId, medicoId, boxId, fecha: new Date(fecha), horaInicio, horaFin, estado: 'agendada', updatedById: usuarioId },
          });

          await registrar({ usuarioId, accion: 'CREATE', entidad: 'Cita', entidadId: nuevaCita.id }, tx);
          return nuevaCita;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      // La cita ya quedó agendada (transacción comprometida); una falla al
      // notificar no debe revertirla ni hacer fallar la respuesta al cliente,
      // así que corre fuera de la transacción y solo se registra si falla.
      try {
        const medico = await prisma.medico.findUnique({ where: { id: medicoId }, select: { usuarioId: true } });
        if (medico?.usuarioId) {
          await crearNotificacion({
            usuarioId: medico.usuarioId,
            mensaje: `Nueva cita agendada para el ${new Date(fecha).toISOString().slice(0, 10)} de ${horaInicio} a ${horaFin}.`,
          });
        }
      } catch (notifErr) {
        logger.error({ err: notifErr, citaId: cita.id }, 'No se pudo crear la notificación de nueva cita');
      }

      return cita;
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

  const anulada = await prisma.$transaction(async (tx) => {
    const resultado = await tx.cita.update({
      where: { id: citaId },
      data: { anulada: true, updatedById: usuarioId },
    });

    await registrar({ usuarioId, accion: 'ANULAR', entidad: 'Cita', entidadId: citaId }, tx);
    return resultado;
  });

  try {
    const medico = await prisma.medico.findUnique({ where: { id: cita.medicoId }, select: { usuarioId: true } });
    if (medico?.usuarioId) {
      await crearNotificacion({
        usuarioId: medico.usuarioId,
        mensaje: `Se anuló la cita del ${anulada.fecha.toISOString().slice(0, 10)} de ${anulada.horaInicio} a ${anulada.horaFin}.`,
      });
    }
  } catch (notifErr) {
    logger.error({ err: notifErr, citaId }, 'No se pudo crear la notificación de cita anulada');
  }

  return anulada;
}

async function listarCitas({ boxId, medicoId, pasilloId, fecha, page = 1, pageSize = 20 } = {}) {
  const where = {
    anulada: false,
    ...(boxId ? { boxId: Number(boxId) } : {}),
    ...(medicoId ? { medicoId: Number(medicoId) } : {}),
    ...(pasilloId ? { box: { pasilloId: Number(pasilloId) } } : {}),
    ...(fecha ? { fecha: new Date(fecha) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.cita.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { horaInicio: 'asc' },
      include: { medico: true, box: { include: { pasillo: true } } },
    }),
    prisma.cita.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

// No incluye datos de Paciente a propósito: esta restricción global del
// proyecto exige que toda lectura de datos de paciente pase por
// pacienteService (con su propia auditoría), nunca por un include aquí.
async function obtenerCitaPorId(id) {
  const cita = await prisma.cita.findUnique({
    where: { id },
    include: { medico: { include: { especialidad: true } }, box: { include: { pasillo: true } } },
  });
  if (!cita) throw new AppError('Cita no encontrada', 404);
  return cita;
}

// No incluye datos de Paciente, por la misma razón que obtenerCitaPorId: se
// exporta únicamente el id de referencia, nunca nombre ni datos clínicos.
// Filtros opcionales: desde/hasta (AAAA-MM-DD, inclusivos) y estado
// (agendada, atendido, no_atendido o anulada). Sin filtros exporta todas,
// incluidas las anuladas, como antes.
function construirWhereExport({ desde, hasta, estado } = {}) {
  const fecha = {};
  if (desde) fecha.gte = new Date(desde);
  if (hasta) fecha.lte = new Date(hasta);

  let porEstado = {};
  if (estado === 'anulada') porEstado = { anulada: true };
  else if (estado) porEstado = { estado, anulada: false };

  return {
    ...(Object.keys(fecha).length > 0 ? { fecha } : {}),
    ...porEstado,
  };
}

async function listarTodasParaExport(usuarioId, filtros = {}) {
  const items = await prisma.cita.findMany({
    where: construirWhereExport(filtros),
    orderBy: [{ fecha: 'asc' }, { horaInicio: 'asc' }],
    include: { medico: true, box: { include: { pasillo: true } } },
  });

  await registrar({ usuarioId, accion: 'EXPORT', entidad: 'Cita', entidadId: 0 });
  return items;
}

module.exports = {
  verificarConflicto,
  crearCita,
  actualizarEstadoCita,
  anularCita,
  listarCitas,
  obtenerCitaPorId,
  listarTodasParaExport,
};
