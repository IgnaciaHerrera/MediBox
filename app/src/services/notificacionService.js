const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function crearNotificacion({ usuarioId, mensaje }) {
  return prisma.notificacion.create({ data: { usuarioId, mensaje } });
}

async function listarPorUsuario(usuarioId, { page = 1, pageSize = 20 } = {}) {
  const [items, total] = await Promise.all([
    prisma.notificacion.findMany({ where: { usuarioId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.notificacion.count({ where: { usuarioId } }),
  ]);
  return { items, total, page, pageSize };
}

async function marcarLeida(notificacionId, usuarioId) {
  const notificacion = await prisma.notificacion.findUnique({ where: { id: notificacionId } });
  if (!notificacion || notificacion.usuarioId !== usuarioId) throw new AppError('Notificación no encontrada', 404);
  return prisma.notificacion.update({ where: { id: notificacionId }, data: { leida: true } });
}

module.exports = { crearNotificacion, listarPorUsuario, marcarLeida };
