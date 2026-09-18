const notificacionService = require('../services/notificacionService');

async function index(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    res.json(await notificacionService.listarPorUsuario(req.usuario.id, { page, pageSize }));
  } catch (err) {
    next(err);
  }
}

async function marcarLeida(req, res, next) {
  try {
    res.json(await notificacionService.marcarLeida(Number(req.params.id), req.usuario.id));
  } catch (err) {
    next(err);
  }
}

async function marcarTodasLeidas(req, res, next) {
  try {
    await notificacionService.marcarTodasLeidas(req.usuario.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { index, marcarLeida, marcarTodasLeidas };
