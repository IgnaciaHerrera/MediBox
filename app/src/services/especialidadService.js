const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function listar() {
  return prisma.especialidad.findMany({ orderBy: { nombre: 'asc' } });
}

async function obtenerPorId(id) {
  const especialidad = await prisma.especialidad.findUnique({ where: { id } });
  if (!especialidad) throw new AppError('Especialidad no encontrada', 404);
  return especialidad;
}

async function crear({ nombre }) {
  const existente = await prisma.especialidad.findUnique({ where: { nombre } });
  if (existente) throw new AppError('Ya existe una especialidad con ese nombre', 409);
  return prisma.especialidad.create({ data: { nombre } });
}

async function actualizar(id, { nombre }) {
  await obtenerPorId(id);
  const duplicado = await prisma.especialidad.findUnique({ where: { nombre } });
  if (duplicado && duplicado.id !== id) throw new AppError('Ya existe una especialidad con ese nombre', 409);
  return prisma.especialidad.update({ where: { id }, data: { nombre } });
}

// Bloquea la baja si todavía hay médicos con esta especialidad: reasignarlos
// es una decisión humana, no algo para inferir automáticamente.
async function eliminar(id) {
  await obtenerPorId(id);
  const totalMedicos = await prisma.medico.count({ where: { especialidadId: id } });
  if (totalMedicos > 0) {
    throw new AppError('No puedes eliminar una especialidad con médicos asignados. Reasígnalos primero.', 400);
  }
  return prisma.especialidad.delete({ where: { id } });
}

module.exports = { listar, obtenerPorId, crear, actualizar, eliminar };
