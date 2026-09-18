const { prisma } = require('../lib/prisma');

async function registrar({ usuarioId, accion, entidad, entidadId }, client = prisma) {
  await client.auditLog.create({ data: { usuarioId, accion, entidad, entidadId } });
}

function construirWhere({ accion, entidad, usuarioId, desde, hasta } = {}) {
  const timestamp = {};
  if (desde) timestamp.gte = new Date(`${desde}T00:00:00.000Z`);
  if (hasta) timestamp.lte = new Date(`${hasta}T23:59:59.999Z`);

  return {
    ...(accion ? { accion } : {}),
    ...(entidad ? { entidad } : {}),
    ...(usuarioId ? { usuarioId: Number(usuarioId) } : {}),
    ...(Object.keys(timestamp).length > 0 ? { timestamp } : {}),
  };
}

async function listar({ page = 1, pageSize = 20, accion, entidad, usuarioId, desde, hasta } = {}) {
  const where = construirWhere({ accion, entidad, usuarioId, desde, hasta });
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { usuario: true },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

async function listarTodo(usuarioId) {
  const items = await prisma.auditLog.findMany({ orderBy: { timestamp: 'desc' }, include: { usuario: true } });
  await registrar({ usuarioId, accion: 'EXPORT', entidad: 'AuditLog', entidadId: 0 });
  return items;
}

async function obtenerUltimoRegistro({ accion, entidad }) {
  return prisma.auditLog.findFirst({
    where: { accion, entidad },
    orderBy: { timestamp: 'desc' },
    include: { usuario: true },
  });
}

async function listarPorEntidad(entidad, entidadId) {
  return prisma.auditLog.findMany({
    where: { entidad, entidadId },
    orderBy: { timestamp: 'asc' },
    include: { usuario: true },
  });
}

// Opciones reales presentes en la tabla, no una lista hardcodeada que se
// desactualizaría en cuanto un servicio nuevo empiece a auditar algo distinto.
async function listarAccionesDistintas() {
  const filas = await prisma.auditLog.findMany({ distinct: ['accion'], select: { accion: true }, orderBy: { accion: 'asc' } });
  return filas.map((f) => f.accion);
}

async function listarEntidadesDistintas() {
  const filas = await prisma.auditLog.findMany({ distinct: ['entidad'], select: { entidad: true }, orderBy: { entidad: 'asc' } });
  return filas.map((f) => f.entidad);
}

module.exports = {
  registrar,
  listar,
  listarTodo,
  obtenerUltimoRegistro,
  listarPorEntidad,
  listarAccionesDistintas,
  listarEntidadesDistintas,
};
