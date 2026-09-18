const notificacionService = require('../services/notificacionService');

async function index(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const { items: notificaciones, total } = await notificacionService.listarPorUsuario(req.usuario.id, { page, pageSize: 20 });
    res.render('notificaciones/index', {
      titulo: 'Notificaciones',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      notificaciones,
      total,
    });
  } catch (err) {
    next(err);
  }
}

async function marcarLeida(req, res, next) {
  try {
    const id = Number(req.params.id);
    await notificacionService.marcarLeida(id, req.usuario.id);
    res.redirect('/notificaciones');
  } catch (err) {
    next(err);
  }
}

async function marcarTodas(req, res, next) {
  try {
    await notificacionService.marcarTodasLeidas(req.usuario.id);
    res.redirect('/notificaciones');
  } catch (err) {
    next(err);
  }
}

module.exports = { index, marcarLeida, marcarTodas };
