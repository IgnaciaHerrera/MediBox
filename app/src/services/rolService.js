const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

async function listar() {
  return prisma.rol.findMany({
    include: { permisos: { include: { permiso: true } } },
    orderBy: { nombre: 'asc' },
  });
}

async function obtenerPorId(id) {
  const rol = await prisma.rol.findUnique({
    where: { id },
    include: { permisos: { include: { permiso: true } } },
  });
  if (!rol) throw new AppError('Rol no encontrado', 404);
  return rol;
}

async function listarPermisosDisponibles() {
  return prisma.permiso.findMany({ orderBy: { clave: 'asc' } });
}

// Reemplaza el conjunto completo de permisos de un rol por `clavesPermisos`.
async function actualizarPermisos(rolId, clavesPermisos) {
  const rolActual = await obtenerPorId(rolId);

  // Salvaguarda: el rol "admin" nunca puede quedar sin `admin.roles`, o nadie
  // podría volver a entrar a esta pantalla para corregirlo.
  let clavesFinales = clavesPermisos;
  if (rolActual.nombre === 'admin' && !clavesFinales.includes('admin.roles')) {
    clavesFinales = [...clavesFinales, 'admin.roles'];
  }

  const permisos = await prisma.permiso.findMany({ where: { clave: { in: clavesFinales } } });

  return prisma.$transaction(async (tx) => {
    await tx.rolPermiso.deleteMany({ where: { rolId } });
    if (permisos.length > 0) {
      await tx.rolPermiso.createMany({
        data: permisos.map((p) => ({ rolId, permisoId: p.id })),
      });
    }
    // Lectura final DENTRO de la misma transacción (con `tx`, no el cliente
    // global): fuera de ella, en otra conexión, todavía no vería los cambios
    // recién hechos porque la transacción no ha comprometido.
    return tx.rol.findUnique({
      where: { id: rolId },
      include: { permisos: { include: { permiso: true } } },
    });
  });
}

module.exports = { listar, obtenerPorId, listarPermisosDisponibles, actualizarPermisos };
