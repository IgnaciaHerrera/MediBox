const { prisma } = require('../lib/prisma');

async function listarPorBox(boxId) {
  return prisma.instrumento.findMany({ where: { boxId } });
}

async function crear({ nombre, boxId }) {
  return prisma.instrumento.create({ data: { nombre, boxId } });
}

module.exports = { listarPorBox, crear };
