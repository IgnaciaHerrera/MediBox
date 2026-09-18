const { prisma } = require('../lib/prisma');

async function listar() {
  return prisma.especialidad.findMany({ orderBy: { nombre: 'asc' } });
}

async function crear({ nombre }) {
  return prisma.especialidad.create({ data: { nombre } });
}

module.exports = { listar, crear };
