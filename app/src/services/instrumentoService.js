const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function listarPorBox(boxId) {
  return prisma.instrumento.findMany({ where: { boxId } });
}

async function crear({ nombre, boxId }) {
  return prisma.instrumento.create({ data: { nombre, boxId } });
}

async function eliminar(id, boxId) {
  const instrumento = await prisma.instrumento.findUnique({ where: { id } });
  if (!instrumento || instrumento.boxId !== boxId) throw new AppError('Instrumento no encontrado', 404);
  return prisma.instrumento.delete({ where: { id } });
}

module.exports = { listarPorBox, crear, eliminar };
