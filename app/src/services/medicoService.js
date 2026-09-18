const { prisma } = require('../lib/prisma');

async function listar() {
  return prisma.medico.findMany({ include: { especialidad: true }, orderBy: { nombre: 'asc' } });
}

async function crear({ nombre, especialidadId }) {
  return prisma.medico.create({ data: { nombre, especialidadId } });
}

module.exports = { listar, crear };
