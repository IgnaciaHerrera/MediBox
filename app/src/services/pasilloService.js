const { prisma } = require('../lib/prisma');

async function listar() {
  return prisma.pasillo.findMany({ include: { boxes: true }, orderBy: { nombre: 'asc' } });
}

module.exports = { listar };
