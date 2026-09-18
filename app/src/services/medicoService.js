const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function listar() {
  return prisma.medico.findMany({ include: { especialidad: true, usuario: true }, orderBy: { nombre: 'asc' } });
}

async function obtenerPorId(id) {
  const medico = await prisma.medico.findUnique({ where: { id }, include: { especialidad: true, usuario: true } });
  if (!medico) throw new AppError('Médico no encontrado', 404);
  return medico;
}

async function crear({ nombre, especialidadId, usuarioId }) {
  return prisma.medico.create({ data: { nombre, especialidadId, usuarioId: usuarioId || null } });
}

// El vínculo con una cuenta de usuario ahora se gestiona sobre todo desde
// usuarioService (vista /usuarios); `usuarioId` aquí solo se toca si viene
// explícito (p. ej. la API JSON de bajo nivel) — si viene `undefined` (la
// vista de /medicos ya no lo envía) el vínculo existente queda intacto en
// vez de borrarse por accidente en cada renombre.
async function actualizar(id, { nombre, especialidadId, usuarioId }) {
  await obtenerPorId(id);
  const data = { nombre, especialidadId };
  if (usuarioId !== undefined) data.usuarioId = usuarioId || null;
  return prisma.medico.update({ where: { id }, data });
}

async function obtenerPorUsuarioId(usuarioId) {
  return prisma.medico.findUnique({ where: { usuarioId }, include: { especialidad: true } });
}

// Bloquea la baja si el médico tiene citas — incluidas las anuladas —, por la
// misma razón de trazabilidad que aplica a boxes: borrar dejaría huérfano el
// historial clínico y de auditoría de esas citas.
async function eliminar(id) {
  await obtenerPorId(id);
  const totalCitas = await prisma.cita.count({ where: { medicoId: id } });
  if (totalCitas > 0) {
    throw new AppError('No puedes eliminar un médico con citas registradas (ni siquiera anuladas), para preservar el historial.', 400);
  }
  return prisma.medico.delete({ where: { id } });
}

module.exports = { listar, obtenerPorId, crear, actualizar, obtenerPorUsuarioId, eliminar };
