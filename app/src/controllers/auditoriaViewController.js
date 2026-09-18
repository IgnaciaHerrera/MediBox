const auditService = require('../services/auditService');
const usuarioService = require('../services/usuarioService');

async function index(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = 30;
    const { accion, entidad, usuarioId, desde, hasta } = req.query;

    const [{ items: registros, total }, acciones, entidades, usuarios] = await Promise.all([
      auditService.listar({ page, pageSize, accion, entidad, usuarioId, desde, hasta }),
      auditService.listarAccionesDistintas(),
      auditService.listarEntidadesDistintas(),
      usuarioService.listar(),
    ]);

    res.render('auditoria/index', {
      titulo: 'Auditoría',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      registros,
      total,
      page,
      totalPaginas: Math.max(1, Math.ceil(total / pageSize)),
      acciones,
      entidades,
      usuarios,
      filtros: {
        accion: accion || '',
        entidad: entidad || '',
        usuarioId: usuarioId || '',
        desde: desde || '',
        hasta: hasta || '',
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { index };
