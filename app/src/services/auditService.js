const { prisma } = require('../lib/prisma');

async function registrar({ usuarioId, accion, entidad, entidadId }, client = prisma) {
  await client.auditLog.create({ data: { usuarioId, accion, entidad, entidadId } });
}

async function listar({ page = 1, pageSize = 20 } = {}) {
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count(),
  ]);
  return { items, total, page, pageSize };
}

module.exports = { registrar, listar };
