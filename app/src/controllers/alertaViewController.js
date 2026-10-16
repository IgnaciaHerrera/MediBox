const Joi = require('joi');
const alertasService = require('../services/alertasService');
const { AppError } = require('../lib/AppError');
const { hoyISO } = require('../lib/fecha');

const DIAS_POR_OMISION = 7;
const fecha = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).empty('');
const filtrosSchema = Joi.object({ desde: fecha, hasta: fecha });

function haceDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

async function index(req, res, next) {
  try {
    const { error, value } = filtrosSchema.validate(req.query, { stripUnknown: true });
    if (error) throw new AppError('Fechas inválidas', 400);
    const hasta = value.hasta || hoyISO();
    const desde = value.desde || haceDias(hasta, DIAS_POR_OMISION - 1);
    const alertas = await alertasService.detectar({ desde: new Date(`${desde}T00:00:00`), hasta: new Date(`${hasta}T23:59:59.999`) });
    res.render('alertas/index', {
      titulo: 'Alertas',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      alertas,
      reglas: alertasService.REGLAS,
      filtros: { desde, hasta },
      diasMaximos: alertasService.DIAS_MAXIMOS,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { index };
