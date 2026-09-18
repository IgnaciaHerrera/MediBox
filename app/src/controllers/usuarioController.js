const Joi = require('joi');
const usuarioService = require('../services/usuarioService');
const { AppError } = require('../lib/AppError');

const crearSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  password: Joi.string().min(8).required(),
  rolId: Joi.number().integer().positive().required(),
});

const actualizarSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  rolId: Joi.number().integer().positive().required(),
});

async function index(req, res, next) {
  try {
    res.json(await usuarioService.listar());
  } catch (err) {
    next(err);
  }
}

async function show(req, res, next) {
  try {
    res.json(await usuarioService.obtenerPorId(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
}

async function store(req, res, next) {
  try {
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.status(201).json(await usuarioService.crear(value));
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = actualizarSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.json(await usuarioService.actualizar(id, value, req.usuario.id));
  } catch (err) {
    next(err);
  }
}

module.exports = { index, show, store, update };
