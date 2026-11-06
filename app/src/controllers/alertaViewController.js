const Joi = require('joi');
const alertasService = require('../services/alertasService');
const { AppError } = require('../lib/AppError');
const { hoyISO } = require('../lib/fecha');
const { responderAccion } = require('../lib/responderError');

// Alertas de accesos anómalos: las revisan el gestor y privacidad
// (alertas.revisar), cada una el rol responsable de su regla.

const fecha = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).empty('');
const filtroSchema = Joi.object({ estado: Joi.string().valid(...alertasService.ESTADOS_ALERTA, 'todas').empty('').default('pendiente') });
const ventanaSchema = Joi.object({ desde: fecha.required(), hasta: fecha.required() });

function idDe(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError('Id inválido', 400);
  return id;
}

async function index(req, res, next) {
  try {
    const { error, value } = filtroSchema.validate(req.query, { stripUnknown: true });
    if (error) throw new AppError('Filtro inválido', 400);
    res.render('alertas/index', {
      titulo: 'Alertas',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      alertas: await alertasService.listar({ estado: value.estado === 'todas' ? undefined : value.estado }),
      reglas: alertasService.REGLAS,
      filtros: { estado: value.estado, hoy: hoyISO() },
      diasMaximos: alertasService.DIAS_MAXIMOS,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Aplica las reglas a un período elegido (por ejemplo, el de un incidente
 * que se investiga) y guarda las alertas que encuentre.
 *
 * Consumidores: routes/alertaViews.js (POST /alertas/analizar).
 */
async function analizar(req, res, next) {
  try {
    const { error, value } = ventanaSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new AppError('Indica el período con fechas válidas', 400);
    const { detectadas, nuevas } = await alertasService.analizar({ desde: new Date(`${value.desde}T00:00:00`), hasta: new Date(`${value.hasta}T23:59:59.999`) });
    responderAccion(req, res, `${detectadas} alerta${detectadas === 1 ? '' : 's'} en el período; ${nuevas.length} nueva${nuevas.length === 1 ? '' : 's'}`, { detectadas, nuevas: nuevas.length }, '/alertas');
  } catch (err) {
    next(err);
  }
}

async function descartar(req, res, next) {
  try {
    await alertasService.descartar(idDe(req), req.body.motivo, req.usuario);
    responderAccion(req, res, 'Alerta descartada', {}, '/alertas');
  } catch (err) {
    next(err);
  }
}

module.exports = { index, analizar, descartar };
