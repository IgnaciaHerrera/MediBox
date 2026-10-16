const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { registrar } = require('./auditService');

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

/**
 * Reemplaza el conjunto completo de permisos de un rol por `clavesPermisos`.
 *
 * Separación de funciones: nadie puede cambiar los permisos de su propio rol
 * (un admin no puede darse acceso a los datos de pacientes). Reenviar el
 * mismo conjunto no es un cambio: la matriz de roles guarda todos los roles
 * de una vez, incluido el de quien la edita. Cada cambio real queda auditado,
 * para que el gestor vea quién amplió o redujo el acceso de un rol.
 *
 * @param {number} rolId
 * @param {string[]} clavesPermisos - claves del conjunto nuevo.
 * @param {{id: number, rolId: number}} solicitante - req.usuario.
 * @returns {Promise<object>} el rol con sus permisos.
 * @throws {AppError} 404 si el rol no existe; 403 si es el propio y cambia.
 *
 * Consumidores: rolController.update, rolViewController.actualizarTodo.
 */
async function actualizarPermisos(rolId, clavesPermisos, solicitante) {
  const rolActual = await obtenerPorId(rolId);

  // Salvaguarda: el rol "admin" nunca puede quedar sin `admin.roles`, o nadie
  // podría volver a entrar a esta pantalla para corregirlo.
  let clavesFinales = clavesPermisos;
  if (rolActual.nombre === 'admin' && !clavesFinales.includes('admin.roles')) {
    clavesFinales = [...clavesFinales, 'admin.roles'];
  }

  const permisos = await prisma.permiso.findMany({ where: { clave: { in: clavesFinales } } });

  const actuales = rolActual.permisos.map((rp) => rp.permiso.clave).sort();
  const nuevas = permisos.map((p) => p.clave).sort();
  if (actuales.join() === nuevas.join()) return rolActual;
  if (solicitante.rolId === rolId) throw new AppError('No puedes cambiar los permisos de tu propio rol', 403);

  return prisma.$transaction(async (tx) => {
    await tx.rolPermiso.deleteMany({ where: { rolId } });
    if (permisos.length > 0) {
      await tx.rolPermiso.createMany({
        data: permisos.map((p) => ({ rolId, permisoId: p.id })),
      });
    }
    await registrar({ usuarioId: solicitante.id, accion: 'UPDATE_PERMISOS', entidad: 'Rol', entidadId: rolId }, tx);
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
