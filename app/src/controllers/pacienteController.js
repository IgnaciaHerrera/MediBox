const Joi = require('joi');
const pacienteService = require('../services/pacienteService');
const { AppError } = require('../lib/AppError');

const crearSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  rut: Joi.string().min(7).max(12).required(),
  fechaNacimiento: Joi.date().iso().required(),
  contacto: Joi.string().min(5).max(100).required(),
  motivoConsulta: Joi.string().min(2).max(300).required(),
});

async function index(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const q = req.query.q;
    res.json(await pacienteService.listarPacientes({ page, pageSize, q }, req.usuario.id));
  } catch (err) {
    next(err);
  }
}

async function show(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError('Id inválido', 400);
    res.json(await pacienteService.obtenerPacientePorId(id, req.usuario.id));
  } catch (err) {
    next(err);
  }
}

async function store(req, res, next) {
  try {
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.status(201).json(await pacienteService.crearPaciente(value, req.usuario.id));
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError('Id inválido', 400);
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    res.json(await pacienteService.actualizarPaciente(id, value, req.usuario.id));
  } catch (err) {
    next(err);
  }
}

module.exports = { index, show, store, update };
