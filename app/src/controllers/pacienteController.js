const Joi = require('joi');
const pacienteService = require('../services/pacienteService');
const { AppError } = require('../lib/AppError');
const { normalizarRut, rutValido } = require('../lib/rut');

const crearSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  rut: Joi.string()
    .max(12)
    .required()
    .custom((valor, helpers) =>
      rutValido(valor) ? normalizarRut(valor) : helpers.message('El RUT no es válido: revisa el dígito verificador'),
    ),
  fechaNacimiento: Joi.date().iso().max('now').required(),
  // Opcional: un campo vacío del formulario cuenta como "sin contacto".
  contacto: Joi.string().trim().min(5).max(100).empty(''),
});

// La búsqueda (nombre o RUT) va en el cuerpo de un POST, nunca en la URL:
// así no queda en el historial del navegador ni en logs intermedios. El
// listado por GET no filtra.
async function index(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    res.json(await pacienteService.listarPacientes({ page, pageSize }, req.usuario));
  } catch (err) {
    next(err);
  }
}

const buscarSchema = Joi.object({
  q: Joi.string().trim().max(150).allow('').default(''),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(200).default(20),
});

async function buscar(req, res, next) {
  try {
    const { error, value } = buscarSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new AppError(error.details[0].message, 400);
    res.json(await pacienteService.listarPacientes(value, req.usuario));
  } catch (err) {
    next(err);
  }
}

async function show(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError('Id inválido', 400);
    res.json(await pacienteService.obtenerPacientePorId(id, req.usuario));
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

module.exports = { index, buscar, show, store, update };
