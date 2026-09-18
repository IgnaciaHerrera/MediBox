const Joi = require('joi');
const rolService = require('../services/rolService');
const { AppError } = require('../lib/AppError');

const actualizarSchema = Joi.object({
  permisos: Joi.array().items(Joi.string()).required(),
});

async function index(req, res, next) {
  try {
    res.json(await rolService.listar());
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = actualizarSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.json(await rolService.actualizarPermisos(id, value.permisos));
  } catch (err) {
    next(err);
  }
}

module.exports = { index, update };
