const { responderError } = require('../lib/responderError');

/**
 * Exige que el usuario autenticado tenga un permiso.
 *
 * @param {string} clave - clave del permiso, p. ej. 'paciente.read'.
 * @returns {Function} middleware de Express que responde 403 si falta.
 *
 * Consumidores: todos los routers de src/routes.
 */
function requirePermission(clave) {
  return requireAnyPermission(clave);
}

/**
 * Exige que el usuario autenticado tenga al menos uno de los permisos. Sirve
 * para las rutas que admiten un permiso global y otro acotado a lo propio
 * (p. ej. 'paciente.read' o 'paciente.read.propios'); el acotamiento lo
 * aplica después el servicio.
 *
 * @param {...string} claves - permisos aceptados.
 * @returns {Function} middleware de Express que responde 403 si no tiene ninguno.
 *
 * Consumidores: requirePermission(), routes/pacientes.js,
 *   routes/pacienteViews.js, routes/citas.js, routes/agendaViews.js.
 */
function requireAnyPermission(...claves) {
  return (req, res, next) => {
    if (!req.usuario || !claves.some((clave) => req.usuario.permisos.includes(clave))) {
      return responderError(req, res, 403, 'Permiso insuficiente');
    }
    return next();
  };
}

module.exports = { requirePermission, requireAnyPermission };
