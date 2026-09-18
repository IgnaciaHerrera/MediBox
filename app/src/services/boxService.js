const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function listar() {
  return prisma.box.findMany({ include: { pasillo: true }, orderBy: { nombre: 'asc' } });
}

async function obtenerPorId(id) {
  const box = await prisma.box.findUnique({ where: { id }, include: { instrumentos: true } });
  if (!box) throw new AppError('Box no encontrado', 404);
  return box;
}

async function crear({ nombre, pasilloId }) {
  return prisma.box.create({ data: { nombre, pasilloId } });
}

module.exports = { listar, obtenerPorId, crear };
