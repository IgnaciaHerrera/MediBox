const Joi = require('joi');
const medicoService = require('../services/medicoService');
const { AppError } = require('../lib/AppError');

const crearSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  especialidadId: Joi.number().integer().positive().required(),
  usuarioId: Joi.number().integer().positive().allow(null, '').optional(),
});

async function index(req, res, next) {
  try {
    const medicos = await medicoService.listar();
    res.json(medicos);
  } catch (err) {
    next(err);
  }
}

async function store(req, res, next) {
  try {
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    const medico = await medicoService.crear(value);
    res.status(201).json(medico);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.json(await medicoService.actualizar(id, { ...value, usuarioId: value.usuarioId || null }));
  } catch (err) {
    next(err);
  }
}

async function destroy(req, res, next) {
  try {
    const id = Number(req.params.id);
    await medicoService.eliminar(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { index, store, update, destroy };
