function requirePermission(clave) {
  return (req, res, next) => {
    if (!req.usuario || !req.usuario.permisos.includes(clave)) {
      return res.status(403).json({ error: 'Permiso insuficiente' });
    }
    return next();
  };
}

module.exports = { requirePermission };
