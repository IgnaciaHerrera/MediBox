const Joi = require('joi');
const especialidadService = require('../services/especialidadService');
const { AppError } = require('../lib/AppError');

const crearSchema = Joi.object({ nombre: Joi.string().min(2).max(100).required() });

async function index(req, res, next) {
  try {
    const especialidades = await especialidadService.listar();
    res.json(especialidades);
  } catch (err) {
    next(err);
  }
}

async function store(req, res, next) {
  try {
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    const especialidad = await especialidadService.crear(value);
    res.status(201).json(especialidad);
  } catch (err) {
    next(err);
  }
}

module.exports = { index, store };
