const { setTimeout: esperar } = require('timers/promises');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const portalService = require('../services/portalService');
const { registrar } = require('../services/auditService');
const { issueCsrfToken } = require('../middleware/csrf');
const { AppError } = require('../lib/AppError');
const { toast } = require('../lib/toast');
const { TRATAMIENTO } = require('../lib/tratamiento');
const consentimientoService = require('../services/consentimientoService');

// Portal temporal del titular: público, sin cuentas. Ver
// services/portalService.js para el modelo de amenazas. Ninguna ruta recibe
// el id de un paciente: el titular es siempre el de la sesión.

const router = express.Router();

function limitador(max, accion) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: async (req, res, next) => {
      try {
        await registrar({ actor: 'portal', accion, entidad: 'Sistema', entidadId: 0, resultado: 'denegado' });
        next(new AppError('Demasiados intentos: espere unos minutos antes de volver a intentarlo', 429));
      } catch (err) {
        next(err);
      }
    },
  });
}
const limiteIngreso = limitador(5, 'PORTAL_LIMITADO');
const limiteCodigo = limitador(10, 'PORTAL_LIMITADO');

// Pedir el código tarda al menos esto, exista o no el RUT: la respuesta no
// revela por su demora si se envió un código.
// ponytail: piso fijo de 400 ms; si la base tarda más en un caso que en el
// otro, la diferencia se vuelve a notar. Upgrade: encolar el envío y
// responder antes de buscar al paciente.
const MINIMO_INGRESO_MS = 400;

const pideHtml = (req) => req.accepts(['json', 'html']) === 'html';

// Las respuestas del portal vuelven siempre a una página fija del portal, no
// a la anterior según el Referer: sin Referer, la respuesta genérica lleva
// al panel del personal.
function responder(req, res, mensaje, datos = {}, destino = '/portal/mis-datos') {
  if (pideHtml(req)) {
    toast(req, mensaje);
    return res.redirect(destino);
  }
  return res.json({ ok: true, mensaje, ...datos });
}

const DESTINO_DEL_ERROR = { '/ingresar': '/portal', '/confirmar': '/portal/codigo' };

function regenerar(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

async function requirePortal(req, res, next) {
  try {
    const titular = await portalService.sesionVigente(req.session.portal);
    if (!titular) {
      delete req.session.portal;
      if (pideHtml(req)) {
        toast(req, 'Su sesión del portal terminó: vuelva a ingresar con su RUT', 'error');
        return res.redirect('/portal');
      }
      return res.status(401).json({ error: 'Sesión del portal vencida o inexistente' });
    }
    req.titular = titular;
    // Lo que se ve en el portal son datos de salud: el navegador no lo guarda.
    res.set('Cache-Control', 'no-store');
    return next();
  } catch (err) {
    return next(err);
  }
}

router.get('/', (req, res) => {
  if (req.session.portal && req.session.portal.expiraEl > Date.now()) return res.redirect('/portal/mis-datos');
  return res.render('portal/ingresar', { titulo: 'Portal del paciente', csrfToken: res.locals.csrfToken });
});

const MENSAJE_ENVIO = 'Si el RUT corresponde a un paciente con un contacto registrado, le enviamos un código de 6 dígitos. Vence en 10 minutos.';

router.post('/ingresar', limiteIngreso, async (req, res, next) => {
  const inicio = Date.now();
  try {
    const rut = typeof req.body.rut === 'string' ? req.body.rut.trim() : '';
    const { verificacionId } = await portalService.solicitarIngreso(rut);
    req.session.portalPendiente = { verificacionId };
    await esperar(Math.max(0, MINIMO_INGRESO_MS - (Date.now() - inicio)));
    if (pideHtml(req)) {
      toast(req, MENSAJE_ENVIO);
      return res.redirect('/portal/codigo');
    }
    return res.json({ ok: true, mensaje: MENSAJE_ENVIO });
  } catch (err) {
    await esperar(Math.max(0, MINIMO_INGRESO_MS - (Date.now() - inicio)));
    return next(err);
  }
});

router.get('/codigo', (req, res) => {
  if (!req.session.portalPendiente) return res.redirect('/portal');
  return res.render('portal/codigo', { titulo: 'Portal del paciente', csrfToken: res.locals.csrfToken });
});

const codigoSchema = Joi.object({ codigo: Joi.string().trim().pattern(/^\d{6}$/).required() }).unknown(true);

router.post('/confirmar', limiteCodigo, async (req, res, next) => {
  try {
    const { error, value } = codigoSchema.validate(req.body);
    if (error) throw new AppError('El código tiene 6 dígitos', 400);
    const pendiente = req.session.portalPendiente;
    if (!pendiente) throw new AppError('Primero ingrese su RUT para recibir un código', 400);

    const sesion = await portalService.confirmarIngreso(pendiente.verificacionId, value.codigo);
    // Identificador de sesión nuevo al verificarse (fijación de sesión), sin
    // nada de la sesión anterior: tampoco la de un funcionario.
    await regenerar(req);
    issueCsrfToken(req, res, () => {});
    req.session.portal = sesion;
    if (pideHtml(req)) return res.redirect('/portal/mis-datos');
    return res.json({ ok: true, expiraEl: new Date(sesion.expiraEl) });
  } catch (err) {
    return next(err);
  }
});

router.get('/mis-datos', requirePortal, async (req, res, next) => {
  try {
    const datos = await portalService.misDatos(req.titular);
    if (!pideHtml(req)) return res.json(datos);
    return res.render('portal/mis-datos', {
      titulo: 'Mis datos',
      csrfToken: res.locals.csrfToken,
      datos,
      expiraEl: new Date(req.titular.expiraEl),
      relaciones: consentimientoService.RELACIONES,
      tratamiento: TRATAMIENTO,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/descargar', requirePortal, async (req, res, next) => {
  try {
    const archivo = await portalService.descargar(req.titular);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mis-datos-medibox.json"');
    return res.send(JSON.stringify(archivo, null, 2));
  } catch (err) {
    return next(err);
  }
});

router.post('/consentimientos/:clave/otorgar', requirePortal, async (req, res, next) => {
  try {
    const representante = req.body.representanteNombre
      ? { nombre: req.body.representanteNombre, rut: req.body.representanteRut, relacion: req.body.representanteRelacion }
      : undefined;
    await portalService.otorgar(req.titular, { finalidadClave: req.params.clave, textoId: req.body.textoId, acepto: req.body.acepto, representante });
    return responder(req, res, 'Consentimiento registrado. Puede revocarlo cuando quiera, aquí mismo.');
  } catch (err) {
    return next(err);
  }
});

router.post('/consentimientos/:clave/revocar', requirePortal, async (req, res, next) => {
  try {
    const revocados = await portalService.revocar(req.titular, req.params.clave);
    return responder(req, res, revocados > 0 ? 'Consentimiento revocado: desde ahora no se usan sus datos para eso.' : 'No tenía ese consentimiento vigente.', { revocados });
  } catch (err) {
    return next(err);
  }
});

router.post('/solicitudes', requirePortal, async (req, res, next) => {
  try {
    const { id, venceEl, pendienteDeCedula } = await portalService.registrarSolicitud(req.titular, req.body);
    const mensaje = pendienteDeCedula
      ? 'Solicitud registrada. Como no se puede deshacer, se ejecuta cuando muestre su cédula en admisión; el plazo de respuesta ya corre.'
      : 'Solicitud registrada: el encargado de protección de datos la revisará.';
    return responder(req, res, mensaje, { id, venceEl, pendienteDeCedula });
  } catch (err) {
    return next(err);
  }
});

router.post('/salir', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    if (pideHtml(req)) return res.redirect('/portal');
    return res.json({ ok: true });
  });
});

// Un error en un formulario del portal vuelve a su página con el aviso; la
// API recibe el JSON de siempre.
router.use((err, req, res, next) => {
  if (!(err instanceof AppError) || !pideHtml(req) || req.method === 'GET') return next(err);
  toast(req, err.message, 'error');
  return res.redirect(303, DESTINO_DEL_ERROR[req.path] || '/portal/mis-datos');
});

module.exports = router;
