const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { registrar } = require('./auditService');

// De la cuenta vinculada solo se trae el correo, que la vista de médicos
// muestra como contacto institucional. Nunca la fila completa: incluiría el
// hash de la contraseña.
const INCLUDE_MEDICO = { especialidad: true, usuario: { select: { id: true, email: true } } };

/**
 * Lista los médicos con su especialidad y el correo de su cuenta, si tienen.
 *
 * @returns {Promise<Array<object>>} médicos ordenados por nombre.
 *
 * Consumidores: medicoController.index, medicoViewController,
 *   agendaViewController, usuarioViewController.
 */
async function listar() {
  return prisma.medico.findMany({ include: INCLUDE_MEDICO, orderBy: { nombre: 'asc' } });
}

async function obtenerPorId(id) {
  const medico = await prisma.medico.findUnique({ where: { id }, include: INCLUDE_MEDICO });
  if (!medico) throw new AppError('Médico no encontrado', 404);
  return medico;
}

/**
 * Crea un médico y lo audita: su nombre es un dato personal del personal.
 *
 * @param {{nombre: string, especialidadId: number, usuarioId?: number}} datos
 * @param {number} solicitanteId - quien lo crea.
 * @returns {Promise<object>} el médico creado.
 *
 * Consumidores: medicoController.store, medicoViewController.
 */
async function crear({ nombre, especialidadId, usuarioId }, solicitanteId) {
  return prisma.$transaction(async (tx) => {
    const medico = await tx.medico.create({ data: { nombre, especialidadId, usuarioId: usuarioId || null } });
    await registrar({ usuarioId: solicitanteId, accion: 'CREATE', entidad: 'Medico', entidadId: medico.id }, tx);
    return medico;
  });
}

// El vínculo con una cuenta de usuario ahora se gestiona sobre todo desde
// usuarioService (vista /usuarios); `usuarioId` aquí solo se toca si viene
// explícito (p. ej. la API JSON de bajo nivel) — si viene `undefined` (la
// vista de /medicos ya no lo envía) el vínculo existente queda intacto en
// vez de borrarse por accidente en cada renombre.
//
// Consumidores: medicoController.update, medicoViewController.
async function actualizar(id, { nombre, especialidadId, usuarioId }, solicitanteId) {
  await obtenerPorId(id);
  const data = { nombre, especialidadId };
  if (usuarioId !== undefined) data.usuarioId = usuarioId || null;
  return prisma.$transaction(async (tx) => {
    const medico = await tx.medico.update({ where: { id }, data });
    await registrar({ usuarioId: solicitanteId, accion: 'UPDATE', entidad: 'Medico', entidadId: id, detalle: { campos: Object.keys(data) } }, tx);
    return medico;
  });
}

async function obtenerPorUsuarioId(usuarioId) {
  return prisma.medico.findUnique({ where: { usuarioId }, include: { especialidad: true } });
}

// Bloquea la baja si el médico tiene citas — incluidas las anuladas —, por la
// misma razón de trazabilidad que aplica a boxes: borrar dejaría huérfano el
// historial clínico y de auditoría de esas citas.
//
// Consumidores: medicoController.destroy, medicoViewController.
async function eliminar(id, solicitanteId) {
  await obtenerPorId(id);
  const totalCitas = await prisma.cita.count({ where: { medicoId: id } });
  if (totalCitas > 0) {
    throw new AppError('No puedes eliminar un médico con citas registradas (ni siquiera anuladas), para preservar el historial.', 400);
  }
  return prisma.$transaction(async (tx) => {
    const medico = await tx.medico.delete({ where: { id } });
    await registrar({ usuarioId: solicitanteId, accion: 'DELETE', entidad: 'Medico', entidadId: id }, tx);
    return medico;
  });
}

module.exports = { listar, obtenerPorId, crear, actualizar, obtenerPorUsuarioId, eliminar };
