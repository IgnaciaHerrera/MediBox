const { responderError } = require('../lib/responderError');
const { registrar } = require('../services/auditService');

// Permisos que protegen datos de pacientes: un intento negado sobre ellos se
// audita (es la señal de alguien buscando datos ajenos a su función).
const PREFIJOS_DATOS_PACIENTE = ['paciente.', 'consentimiento.', 'derechos.'];

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
 *   Si los permisos protegen datos de pacientes, el intento negado queda en la
 *   auditoría como READ 'denegado' sobre el paciente de la ruta (o 0).
 *
 * Consumidores: requirePermission(), routes/pacientes.js,
 *   routes/pacienteViews.js, routes/citas.js, routes/agendaViews.js.
 */
function requireAnyPermission(...claves) {
  const protegePacientes = claves.some((clave) => PREFIJOS_DATOS_PACIENTE.some((prefijo) => clave.startsWith(prefijo)));
  return async (req, res, next) => {
    if (req.usuario && claves.some((clave) => req.usuario.permisos.includes(clave))) return next();
    try {
      if (protegePacientes && req.usuario) {
        const pacienteId = Number(req.params.id ?? req.params.pacienteId);
        await registrar({
          usuarioId: req.usuario.id,
          accion: 'READ',
          entidad: 'Paciente',
          entidadId: Number.isInteger(pacienteId) ? pacienteId : 0,
          resultado: 'denegado',
        });
      }
    } catch (err) {
      return next(err);
    }
    return responderError(req, res, 403, 'Permiso insuficiente');
  };
}

module.exports = { requirePermission, requireAnyPermission };
