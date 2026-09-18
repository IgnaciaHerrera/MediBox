const Joi = require('joi');
const pasilloService = require('../services/pasilloService');
const boxService = require('../services/boxService');
const instrumentoService = require('../services/instrumentoService');
const { AppError } = require('../lib/AppError');

const crearBoxSchema = Joi.object({
  nombre: Joi.string().min(1).max(50).required(),
  pasilloId: Joi.number().integer().positive().required(),
});

const crearInstrumentoSchema = Joi.object({ nombre: Joi.string().min(2).max(100).required() });

async function listarPasillos(req, res, next) {
  try {
    res.json(await pasilloService.listar());
  } catch (err) {
    next(err);
  }
}

async function listarBoxes(req, res, next) {
  try {
    res.json(await boxService.listar());
  } catch (err) {
    next(err);
  }
}

async function crearBox(req, res, next) {
  try {
    const { error, value } = crearBoxSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.status(201).json(await boxService.crear(value));
  } catch (err) {
    next(err);
  }
}

async function listarInstrumentos(req, res, next) {
  try {
    const boxId = Number(req.params.boxId);
    await boxService.obtenerPorId(boxId);
    res.json(await instrumentoService.listarPorBox(boxId));
  } catch (err) {
    next(err);
  }
}

async function crearInstrumento(req, res, next) {
  try {
    const boxId = Number(req.params.boxId);
    await boxService.obtenerPorId(boxId);
    const { error, value } = crearInstrumentoSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.status(201).json(await instrumentoService.crear({ ...value, boxId }));
  } catch (err) {
    next(err);
  }
}

module.exports = { listarPasillos, listarBoxes, crearBox, listarInstrumentos, crearInstrumento };
