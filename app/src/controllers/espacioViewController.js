const Joi = require('joi');
const pasilloService = require('../services/pasilloService');
const boxService = require('../services/boxService');
const instrumentoService = require('../services/instrumentoService');
const citaService = require('../services/citaService');
const { AppError } = require('../lib/AppError');
const { hoyISO } = require('../lib/fecha');

const pasilloSchema = Joi.object({ nombre: Joi.string().min(1).max(50).required() }).unknown(true);
const boxSchema = Joi.object({
  nombre: Joi.string().min(1).max(50).required(),
  pasilloId: Joi.number().integer().positive().required(),
}).unknown(true);
const instrumentoSchema = Joi.object({ nombre: Joi.string().min(2).max(100).required() }).unknown(true);

// Un box cuenta como "ocupado ahora" si tiene una cita agendada hoy cuyo
// rango horario contiene la hora actual (mismo criterio usado en el panel).
async function obtenerBoxesOcupados() {
  const { items: citasHoy } = await citaService.listarCitas({ fecha: hoyISO(), pageSize: 200 });
  const ahora = new Date().toTimeString().slice(0, 5);
  return new Set(
    citasHoy.filter((c) => c.estado === 'agendada' && c.horaInicio <= ahora && ahora <= c.horaFin).map((c) => c.boxId),
  );
}

async function renderIndex(req, res, { error = null, status = 200 } = {}) {
  const [pasillos, boxesOcupados] = await Promise.all([pasilloService.listar(), obtenerBoxesOcupados()]);
  res.status(status).render('espacios/index', {
    titulo: 'Espacios',
    usuario: req.usuario,
    csrfToken: res.locals.csrfToken,
    pasillos,
    boxesOcupados,
    error,
    puedeEscribir: req.usuario.permisos.includes('box.write'),
  });
}

async function index(req, res, next) {
  try {
    await renderIndex(req, res);
  } catch (err) {
    next(err);
  }
}

async function crearPasillo(req, res, next) {
  try {
    const { error, value } = pasilloSchema.validate(req.body);
    if (error) return renderIndex(req, res, { error: error.details[0].message, status: 400 });
    await pasilloService.crear(value);
    return res.redirect('/espacios');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function editarPasillo(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = pasilloSchema.validate(req.body);
    if (error) return renderIndex(req, res, { error: error.details[0].message, status: 400 });
    await pasilloService.actualizar(id, value);
    return res.redirect('/espacios');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function eliminarPasillo(req, res, next) {
  try {
    const id = Number(req.params.id);
    await pasilloService.eliminar(id);
    return res.redirect('/espacios');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function crearBox(req, res, next) {
  try {
    const { error, value } = boxSchema.validate(req.body);
    if (error) return renderIndex(req, res, { error: error.details[0].message, status: 400 });
    await boxService.crear(value);
    return res.redirect('/espacios');
  } catch (err) {
    if (err instanceof AppError) return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
    return next(err);
  }
}

async function renderBoxDetalle(req, res, id, { error = null, status = 200 } = {}) {
  const [box, instrumentos, pasillos, boxesOcupados] = await Promise.all([
    boxService.obtenerPorId(id),
    instrumentoService.listarPorBox(id),
    pasilloService.listar(),
    obtenerBoxesOcupados(),
  ]);
  res.status(status).render('espacios/box', {
    titulo: box.nombre,
    usuario: req.usuario,
    csrfToken: res.locals.csrfToken,
    box,
    instrumentos,
    pasillos,
    ocupado: boxesOcupados.has(id),
    error,
    puedeEditarBox: req.usuario.permisos.includes('box.write'),
    puedeGestionarInstrumental: req.usuario.permisos.includes('box.detalle.write'),
  });
}

async function boxDetalle(req, res, next) {
  try {
    await renderBoxDetalle(req, res, Number(req.params.id));
  } catch (err) {
    next(err);
  }
}

// Tanto el detalle del box como la cuadrícula de /espacios pueden renombrar o
// mover un box; el campo oculto `volver` (solo presente en los formularios en
// línea de la cuadrícula) decide a cuál de las dos pantallas volver, sin
// duplicar rutas ni controladores para lo mismo.
async function actualizarBox(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = boxSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    await boxService.actualizar(id, value);
    if (req.body.volver === 'index') return res.redirect('/espacios');
    return res.redirect(`/espacios/boxes/${id}`);
  } catch (err) {
    if (err instanceof AppError) {
      if (req.body.volver === 'index') return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
      return renderBoxDetalle(req, res, Number(req.params.id), { error: err.message, status: err.statusCode }).catch(next);
    }
    return next(err);
  }
}

async function eliminarBox(req, res, next) {
  try {
    const id = Number(req.params.id);
    await boxService.eliminar(id);
    return res.redirect('/espacios');
  } catch (err) {
    if (err instanceof AppError) {
      if (req.body.volver === 'index') return renderIndex(req, res, { error: err.message, status: err.statusCode }).catch(next);
      return renderBoxDetalle(req, res, Number(req.params.id), { error: err.message, status: err.statusCode }).catch(next);
    }
    return next(err);
  }
}

async function nuevoInstrumento(req, res, next) {
  try {
    const boxId = Number(req.params.id);
    const { error, value } = instrumentoSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    await instrumentoService.crear({ ...value, boxId });
    return res.redirect(`/espacios/boxes/${boxId}`);
  } catch (err) {
    return next(err);
  }
}

async function eliminarInstrumento(req, res, next) {
  try {
    const boxId = Number(req.params.id);
    const instrumentoId = Number(req.params.instrumentoId);
    await instrumentoService.eliminar(instrumentoId, boxId);
    return res.redirect(`/espacios/boxes/${boxId}`);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  index,
  crearPasillo,
  editarPasillo,
  eliminarPasillo,
  crearBox,
  boxDetalle,
  actualizarBox,
  eliminarBox,
  nuevoInstrumento,
  eliminarInstrumento,
};
