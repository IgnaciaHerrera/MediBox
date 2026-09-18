const { prisma } = require('../lib/prisma');
const { obtenerPermisosPorRol } = require('../services/rbacService');

async function attachUsuario(req, res, next) {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.session.usuarioId } });
    if (!usuario) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const permisos = await obtenerPermisosPorRol(usuario.rolId);
    req.usuario = { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rolId: usuario.rolId, permisos };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { attachUsuario };
