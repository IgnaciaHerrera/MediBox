const { prisma } = require('../lib/prisma');

async function obtenerPermisosPorRol(rolId) {
  const asignaciones = await prisma.rolPermiso.findMany({
    where: { rolId },
    include: { permiso: true },
  });
  return asignaciones.map((a) => a.permiso.clave);
}

module.exports = { obtenerPermisosPorRol };
