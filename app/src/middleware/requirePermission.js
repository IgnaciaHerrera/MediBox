const { responderError } = require('../lib/responderError');

function requirePermission(clave) {
  return (req, res, next) => {
    if (!req.usuario || !req.usuario.permisos.includes(clave)) {
      return responderError(req, res, 403, 'Permiso insuficiente');
    }
    return next();
  };
}

module.exports = { requirePermission };
