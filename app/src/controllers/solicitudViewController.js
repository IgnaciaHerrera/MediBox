const derechosService = require('../services/derechosService');
const verificacionService = require('../services/verificacionService');
const { verificarContrasena } = require('../services/authService');
const { registrar } = require('../services/auditService');
const { AppError } = require('../lib/AppError');
const { responderAccion } = require('../lib/responderError');
const { validarFormato, enviarArchivo } = require('../lib/archivoTitular');

// El archivo de un titular concentra todos sus datos: se genera solo con una
// reautenticación reciente del funcionario.
const MINUTOS_REAUTENTICACION = 5;

function idDe(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError('Id inválido', 400);
  return id;
}

function reautenticacionVigente(req) {
  const desde = req.session.reautenticadoEl;
  return Boolean(desde) && Date.now() - desde < MINUTOS_REAUTENTICACION * 60 * 1000;
}

async function index(req, res, next) {
  try {
    res.render('solicitudes/index', {
      titulo: 'Solicitudes de derechos',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      solicitudes: await derechosService.listarPendientes(req.usuario),
      plazoDias: derechosService.PLAZO_RESPUESTA_DIAS,
    });
  } catch (err) {
    next(err);
  }
}

async function detalle(req, res, next) {
  try {
    const datos = await derechosService.obtenerParaGestion(idDe(req), req.usuario);
    res.render('solicitudes/detalle', {
      titulo: 'Solicitud de derechos',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      ...datos,
      verificacion: await verificacionService.estadoParaVista(datos.paciente.id, req.usuario.id, datos.paciente.contacto),
      reautenticado: reautenticacionVigente(req),
    });
  } catch (err) {
    next(err);
  }
}

async function verificar(req, res, next) {
  try {
    await derechosService.verificarSolicitud(idDe(req), req.usuario);
    responderAccion(req, res, 'Solicitud verificada');
  } catch (err) {
    next(err);
  }
}

async function ejecutar(req, res, next) {
  try {
    await derechosService.ejecutar(idDe(req), req.usuario, req.body);
    responderAccion(req, res, 'Solicitud resuelta y respuesta registrada');
  } catch (err) {
    next(err);
  }
}

async function rechazar(req, res, next) {
  try {
    await derechosService.rechazar(idDe(req), req.usuario, req.body);
    responderAccion(req, res, 'Solicitud rechazada y motivo registrado');
  } catch (err) {
    next(err);
  }
}

async function desbloquear(req, res, next) {
  try {
    await derechosService.desbloquear(idDe(req), req.usuario);
    responderAccion(req, res, 'Bloqueo levantado');
  } catch (err) {
    next(err);
  }
}

async function nueva(req, res, next) {
  try {
    const { id } = await derechosService.registrarSolicitud(req.body, req.usuario, { origenSolicitudId: idDe(req) });
    responderAccion(req, res, 'Solicitud registrada: verifica la identidad del titular para resolverla', { id });
  } catch (err) {
    next(err);
  }
}

async function reautenticar(req, res, next) {
  try {
    const valida = await verificarContrasena(req.usuario.id, req.body.password);
    await registrar({ usuarioId: req.usuario.id, accion: 'REAUTENTICAR', entidad: 'Usuario', entidadId: req.usuario.id, resultado: valida ? 'exito' : 'fallido' });
    if (!valida) throw new AppError('Contraseña incorrecta', 401);
    req.session.reautenticadoEl = Date.now();
    responderAccion(req, res, `Contraseña confirmada: tienes ${MINUTOS_REAUTENTICACION} minutos para generar el archivo`);
  } catch (err) {
    next(err);
  }
}

async function descargar(req, res, next) {
  try {
    if (!reautenticacionVigente(req)) {
      throw new AppError('Vuelve a ingresar tu contraseña antes de generar el archivo del titular', 403);
    }
    const id = idDe(req);
    const formato = validarFormato(req.body.formato);
    const archivo = await derechosService.exportarDatosTitular(id, req.usuario, { entrega: req.body.entrega, formato });
    await enviarArchivo(res, archivo, formato, `datos-titular-${id}`);
  } catch (err) {
    next(err);
  }
}

module.exports = { index, detalle, verificar, ejecutar, rechazar, desbloquear, nueva, reautenticar, descargar };
