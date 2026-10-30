const incidenteService = require('../services/incidenteService');
const { AppError } = require('../lib/AppError');
const { responderAccion } = require('../lib/responderError');

// Registro de incidentes de seguridad: lo llevan el gestor (detecta) y
// privacidad (coordina la respuesta). Ver services/incidenteService.js.

function idDe(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError('Id inválido', 400);
  return id;
}

const opciones = {
  origenes: incidenteService.ORIGENES,
  severidades: incidenteService.SEVERIDADES,
  dimensiones: incidenteService.DIMENSIONES,
  categorias: incidenteService.CATEGORIAS,
};

async function index(req, res, next) {
  try {
    res.render('incidentes/index', {
      titulo: 'Incidentes',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      incidentes: await incidenteService.listarIncidentes(),
      opciones,
      // Desde una alerta llega el título sugerido (el nombre de la regla), nada más.
      sugerido: { titulo: typeof req.query.titulo === 'string' ? req.query.titulo.slice(0, 150) : '', origen: req.query.titulo ? 'alerta_automatica' : '' },
    });
  } catch (err) {
    next(err);
  }
}

async function crear(req, res, next) {
  try {
    const { id } = await incidenteService.registrarIncidente(req.body, req.usuario);
    responderAccion(req, res, `Incidente N° ${id} registrado como alerta`, { id }, `/incidentes/${id}`);
  } catch (err) {
    next(err);
  }
}

async function detalle(req, res, next) {
  try {
    res.render('incidentes/detalle', {
      titulo: 'Incidente',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      incidente: await incidenteService.obtener(idDe(req)),
      opciones,
    });
  } catch (err) {
    next(err);
  }
}

async function actualizar(req, res, next) {
  try {
    await incidenteService.actualizarIncidente(idDe(req), req.body, req.usuario);
    responderAccion(req, res, 'Incidente actualizado');
  } catch (err) {
    next(err);
  }
}

async function cambiarEstado(req, res, next) {
  try {
    await incidenteService.cambiarEstado(idDe(req), req.body.estado, req.usuario);
    responderAccion(req, res, 'Estado del incidente actualizado');
  } catch (err) {
    next(err);
  }
}

module.exports = { index, crear, detalle, actualizar, cambiarEstado };
