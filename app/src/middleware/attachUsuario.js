const { prisma } = require('../lib/prisma');
const { obtenerPermisosPorRol } = require('../services/rbacService');
const { contarNoLeidas } = require('../services/notificacionService');
const { responderNoAutenticado } = require('../lib/responderError');

async function attachUsuario(req, res, next) {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.session.usuarioId }, include: { rol: true } });
    // Una cuenta suspendida pierde en la petición siguiente las sesiones que
    // tuviera abiertas, aunque alguna no se haya alcanzado a cerrar.
    if (!usuario || usuario.suspendida) {
      return responderNoAutenticado(req, res);
    }
    const permisos = await obtenerPermisosPorRol(usuario.rolId);
    req.usuario = {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      rolId: usuario.rolId,
      rolNombre: usuario.rol.nombre,
      permisos,
      // Se calcula aquí (una sola vez, en el middleware compartido por toda
      // ruta autenticada) para que el badge del topbar esté disponible en
      // cualquier página sin que cada controlador tenga que pedirlo aparte.
      notificacionesNoLeidas: permisos.includes('notificaciones.read') ? await contarNoLeidas(usuario.id) : 0,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { attachUsuario };
