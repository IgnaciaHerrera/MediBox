const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function listar() {
  return prisma.box.findMany({ include: { pasillo: true }, orderBy: { nombre: 'asc' } });
}

async function obtenerPorId(id) {
  const box = await prisma.box.findUnique({ where: { id }, include: { instrumentos: true, pasillo: true } });
  if (!box) throw new AppError('Box no encontrado', 404);
  return box;
}

async function crear({ nombre, pasilloId }) {
  const existente = await prisma.box.findUnique({ where: { pasilloId_nombre: { pasilloId, nombre } } });
  if (existente) throw new AppError('Ya existe un box con ese nombre en ese pasillo', 409);
  return prisma.box.create({ data: { nombre, pasilloId } });
}

async function actualizar(id, { nombre, pasilloId }) {
  await obtenerPorId(id);
  const duplicado = await prisma.box.findUnique({ where: { pasilloId_nombre: { pasilloId, nombre } } });
  if (duplicado && duplicado.id !== id) throw new AppError('Ya existe un box con ese nombre en ese pasillo', 409);
  return prisma.box.update({ where: { id }, data: { nombre, pasilloId } });
}

// Bloquea la baja si el box tiene citas — incluidas las anuladas — porque
// borrarlo dejaría huérfano el historial clínico y de auditoría asociado a
// esas citas. El instrumental sí se limpia: no tiene valor histórico propio.
async function eliminar(id) {
  await obtenerPorId(id);

  const totalCitas = await prisma.cita.count({ where: { boxId: id } });
  if (totalCitas > 0) {
    throw new AppError('No puedes eliminar un box con citas registradas (ni siquiera anuladas), para preservar el historial.', 400);
  }

  return prisma.$transaction(async (tx) => {
    await tx.instrumento.deleteMany({ where: { boxId: id } });
    return tx.box.delete({ where: { id } });
  });
}

module.exports = { listar, obtenerPorId, crear, actualizar, eliminar };
