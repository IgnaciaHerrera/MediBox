const { responderNoAutenticado } = require('../lib/responderError');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.usuarioId) {
    return responderNoAutenticado(req, res);
  }
  return next();
}

module.exports = { requireAuth };
