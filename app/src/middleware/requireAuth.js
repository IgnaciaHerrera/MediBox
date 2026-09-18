function requireAuth(req, res, next) {
  if (!req.session || !req.session.usuarioId) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  return next();
}

module.exports = { requireAuth };
