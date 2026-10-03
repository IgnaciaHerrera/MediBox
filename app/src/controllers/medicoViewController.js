const Joi = require('joi');
const medicoService = require('../services/medicoService');
const especialidadService = require('../services/especialidadService');
const citaService = require('../services/citaService');
const { AppError } = require('../lib/AppError');
const { hoyISO } = require('../lib/fecha');
const { toast } = require('../lib/toast');

const especialidadSchema = Joi.object({ nombre: Joi.string().min(2).max(100).required() }).unknown(true);
const medicoSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  especialidadId: Joi.number().integer().positive().required(),
}).unknown(true);

// Una sola pasada por las citas de hoy: cuenta cuántas tiene cada médico y,
// de paso, en qué box está atendiendo justo ahora (si corresponde) — antes
// eran dos preguntas separadas, pero salen del mismo conjunto de citas.
async function obtenerInfoCitasHoyPorMedico() {
  const { items: citasHoy } = await citaService.listarCitas({ fecha: hoyISO(), pageSize: 200 });
  const ahora = new Date().toTimeString().slice(0, 5);
  const conteo = new Map();
  const boxActual = new Map();
  citasHoy.forEach((c) => {
    conteo.set(c.medicoId, (conteo.get(c.medicoId) || 0) + 1);
    if (c.estado === 'agendada' && c.horaInicio <= ahora && ahora <= c.horaFin) {
      boxActual.set(c.medicoId, { pasillo: c.box.pasillo.nombre, box: c.box.nombre });
    }
  });
  return { conteo, boxActual };
}

async function renderIndex(req, res, { error = null, status = 200 } = {}) {
  const especialidadId = req.query.especialidadId ? Number(req.query.especialidadId) : null;

  const [medicosTodos, especialidades, infoCitasHoy] = await Promise.all([
    medicoService.listar(),
    especialidadService.listar(),
    obtenerInfoCitasHoyPorMedico(),
  ]);

  const medicos = especialidadId ? medicosTodos.filter((m) => m.especialidadId === especialidadId) : medicosTodos;

  // Cuántos médicos tiene cada especialidad, para el panel lateral (se cuenta
  // sobre todos los médicos, no sobre los filtrados).
  const medicosPorEspecialidad = new Map();
  medicosTodos.forEach((m) => {
    medicosPorEspecialidad.set(m.especialidadId, (medicosPorEspecialidad.get(m.especialidadId) || 0) + 1);
  });

  res.status(status).render('medicos/index', {
    titulo: 'Médicos',
    usuario: req.usuario,
    csrfToken: res.locals.csrfToken,
    medicos,
    especialidades,
    medicosPorEspecialidad,
    totalMedicos: medicosTodos.length,
    citasHoyPorMedico: infoCitasHoy.conteo,
    boxActualPorMedico: infoCitasHoy.boxActual,
    especialidadIdSeleccionada: especialidadId,
    error,
    esAdmin: req.usuario.permisos.includes('admin.system'),
  });
}

async function index(req, res, next) {
  try {
    await renderIndex(req, res);
  } catch (err) {
    next(err);
  }
}

async function crearEspecialidad(req, res, next) {
  try {
    const { error, value } = especialidadSchema.validate(req.body);
    if (error) return renderIndex(req, res, { error: error.details[0].message, status: 400 });
    await especialidadService.crear(value);
    toast(req, 'Especialidad creada');
    return res.redirect('/medicos');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function editarEspecialidad(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = especialidadSchema.validate(req.body);
    if (error) return renderIndex(req, res, { error: error.details[0].message, status: 400 });
    await especialidadService.actualizar(id, value);
    toast(req, 'Especialidad actualizada');
    return res.redirect('/medicos');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function eliminarEspecialidad(req, res, next) {
  try {
    const id = Number(req.params.id);
    await especialidadService.eliminar(id);
    toast(req, 'Especialidad eliminada');
    return res.redirect('/medicos');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function crearMedico(req, res, next) {
  try {
    const { error, value } = medicoSchema.validate(req.body);
    if (error) return renderIndex(req, res, { error: error.details[0].message, status: 400 });
    await medicoService.crear(value);
    toast(req, 'Médico agregado');
    return res.redirect('/medicos');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function eliminarMedico(req, res, next) {
  try {
    const id = Number(req.params.id);
    await medicoService.eliminar(id);
    toast(req, 'Médico eliminado');
    return res.redirect('/medicos');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function editarMedico(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = medicoSchema.validate(req.body);
    if (error) return renderIndex(req, res, { error: error.details[0].message, status: 400 });
    await medicoService.actualizar(id, value);
    toast(req, 'Médico actualizado');
    return res.redirect('/medicos');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

module.exports = {
  index,
  crearEspecialidad,
  editarEspecialidad,
  eliminarEspecialidad,
  crearMedico,
  eliminarMedico,
  editarMedico,
};
