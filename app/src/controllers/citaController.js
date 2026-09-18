const Joi = require('joi');
const citaService = require('../services/citaService');
const { AppError } = require('../lib/AppError');

const crearSchema = Joi.object({
  pacienteId: Joi.number().integer().positive().required(),
  medicoId: Joi.number().integer().positive().required(),
  boxId: Joi.number().integer().positive().required(),
  fecha: Joi.date().iso().required(),
  horaInicio: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  horaFin: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
});

const estadoSchema = Joi.object({ estado: Joi.string().valid('agendada', 'atendido', 'no_atendido').required() });

const conflictoSchema = Joi.object({
  medicoId: Joi.number().integer().positive().required(),
  boxId: Joi.number().integer().positive().required(),
  fecha: Joi.date().iso().required(),
  horaInicio: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  horaFin: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
});

async function index(req, res, next) {
  try {
    const { boxId, medicoId, pasilloId, fecha, page, pageSize } = req.query;
    res.json(await citaService.listarCitas({ boxId, medicoId, pasilloId, fecha, page: Number(page) || 1, pageSize: Number(pageSize) || 20 }));
  } catch (err) {
    next(err);
  }
}

async function store(req, res, next) {
  try {
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.status(201).json(await citaService.crearCita(value, req.usuario.id));
  } catch (err) {
    next(err);
  }
}

async function actualizarEstado(req, res, next) {
  try {
    const { error, value } = estadoSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.json(await citaService.actualizarEstadoCita(Number(req.params.id), value.estado, req.usuario.id));
  } catch (err) {
    next(err);
  }
}

async function anular(req, res, next) {
  try {
    res.json(await citaService.anularCita(Number(req.params.id), req.usuario.id));
  } catch (err) {
    next(err);
  }
}

async function conflicto(req, res, next) {
  try {
    const { error, value } = conflictoSchema.validate(req.query);
    if (error) throw new AppError(error.details[0].message, 400);
    const hayConflicto = await citaService.verificarConflicto(value);
    res.json({ conflicto: hayConflicto });
  } catch (err) {
    next(err);
  }
}

module.exports = { index, store, actualizarEstado, anular, conflicto };
