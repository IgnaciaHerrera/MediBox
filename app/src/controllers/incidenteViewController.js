const incidenteService = require('../services/incidenteService');
const alertasService = require('../services/alertasService');
const usuarioService = require('../services/usuarioService');
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
  fases: incidenteService.FASES,
};

// Las cuentas que pueden estar involucradas: solo id, nombre y rol.
async function cuentas() {
  return (await usuarioService.listar()).map((u) => ({ id: u.id, nombre: u.nombre, rol: u.rol ? u.rol.nombre : '' }));
}

// La alerta cubre solo los eventos de su regla; con una hora de margen se ve
// también lo que pasó antes y después (el inicio de sesión, por ejemplo). El
// análisis lo ajusta.
const MARGEN_ALERTA_MS = 60 * 60 * 1000;

/**
 * Lo que trae prellenado el formulario al escalar una alerta: su regla, su
 * severidad, su período con una hora de margen y la cuenta. Nada de pacientes.
 *
 * @param {object} req
 * @returns {Promise<object>} valores sugeridos para incidentes/_campos.ejs.
 * @throws {AppError} si la alerta no existe, ya se revisó o es sobre la
 *   cuenta de quien la escala.
 *
 * Consumidores: index().
 */
async function sugeridoDe(req) {
  if (req.query.alerta === undefined) return {};
  const alertaId = Number(req.query.alerta);
  if (!Number.isInteger(alertaId)) throw new AppError('Alerta inválida', 400);
  const alerta = await alertasService.alertaParaRevisar(alertaId, req.usuario);
  const regla = alertasService.REGLAS[alerta.regla];
  return {
    alertaId,
    titulo: `Alerta N° ${alerta.id}: ${regla.nombre}`,
    origen: 'alerta_automatica',
    severidad: alerta.severidad,
    descripcion: `${regla.descripcion} Se detectaron ${alerta.cantidad} eventos.`,
    ocurridoDesde: new Date(alerta.desde.getTime() - MARGEN_ALERTA_MS),
    ocurridoHasta: new Date(Math.min(alerta.hasta.getTime() + MARGEN_ALERTA_MS, Date.now())),
    cuentaInvolucradaId: alerta.usuarioId,
  };
}

async function index(req, res, next) {
  try {
    res.render('incidentes/index', {
      titulo: 'Incidentes',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      incidentes: await incidenteService.listarIncidentes(),
      opciones: { ...opciones, cuentas: await cuentas() },
      sugerido: await sugeridoDe(req),
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
    const id = idDe(req);
    const incidente = await incidenteService.obtener(id);
    // Con la cuenta y el período, la auditoría reconstruye lo ocurrido. El
    // formulario guarda el período al minuto: el último minuto va completo.
    const { cuentaInvolucradaId: usuarioId, ocurridoDesde: desde, ocurridoHasta } = incidente;
    const reconstruccion =
      usuarioId && desde && ocurridoHasta
        ? await incidenteService
            .reconstruir({ desde, hasta: new Date(ocurridoHasta.getTime() + 59999), usuarioId, incidenteId: id }, req.usuario)
            .catch((err) => (err instanceof AppError ? { error: err.message } : Promise.reject(err)))
        : null;
    res.render('incidentes/detalle', {
      titulo: 'Incidente',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      incidente,
      bitacora: await incidenteService.bitacora(id),
      reconstruccion,
      opciones: { ...opciones, cuentas: await cuentas() },
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

async function anotar(req, res, next) {
  try {
    await incidenteService.registrarAccion(idDe(req), req.body, req.usuario);
    responderAccion(req, res, 'Acción anotada en la bitácora');
  } catch (err) {
    next(err);
  }
}

module.exports = { index, crear, detalle, actualizar, cambiarEstado, anotar };
