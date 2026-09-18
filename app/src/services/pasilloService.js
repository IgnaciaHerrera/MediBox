const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function listar() {
  return prisma.pasillo.findMany({
    include: { boxes: { include: { _count: { select: { instrumentos: true } } } } },
    orderBy: { nombre: 'asc' },
  });
}

async function obtenerPorId(id) {
  const pasillo = await prisma.pasillo.findUnique({ where: { id } });
  if (!pasillo) throw new AppError('Pasillo no encontrado', 404);
  return pasillo;
}

async function crear({ nombre }) {
  const existente = await prisma.pasillo.findUnique({ where: { nombre } });
  if (existente) throw new AppError('Ya existe un pasillo con ese nombre', 409);
  return prisma.pasillo.create({ data: { nombre } });
}

async function actualizar(id, { nombre }) {
  await obtenerPorId(id);

  const duplicado = await prisma.pasillo.findUnique({ where: { nombre } });
  if (duplicado && duplicado.id !== id) throw new AppError('Ya existe un pasillo con ese nombre', 409);

  return prisma.pasillo.update({ where: { id }, data: { nombre } });
}

// Bloquea la baja si el pasillo todavía tiene boxes: eliminar en cascada
// arrastraría instrumental y, más grave, cualquier cita histórica de esos
// boxes. Obliga a vaciar el pasillo explícitamente primero.
async function eliminar(id) {
  await obtenerPorId(id);

  const totalBoxes = await prisma.box.count({ where: { pasilloId: id } });
  if (totalBoxes > 0) {
    throw new AppError('No puedes eliminar un pasillo que todavía tiene boxes. Elimina o reubica sus boxes primero.', 400);
  }

  return prisma.pasillo.delete({ where: { id } });
}

module.exports = { listar, obtenerPorId, crear, actualizar, eliminar };
