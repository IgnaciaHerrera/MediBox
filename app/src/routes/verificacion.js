const express = require('express');
const Joi = require('joi');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requireAnyPermission } = require('../middleware/requirePermission');
const verificacion = require('../services/verificacionService');
const { AppError } = require('../lib/AppError');
const { responderAccion: responder } = require('../lib/responderError');

const router = express.Router();

// Verifican la identidad quienes atienden peticiones del titular: el
// operador (consentimientos y recepción de solicitudes) y privacidad.
router.use(requireAuth, attachUsuario, requireAnyPermission('consentimiento.write', 'derechos.registrar', 'derechos.gestionar'));

const cedulaSchema = Joi.object({ cedulaVista: Joi.string().valid('si').required() }).unknown(true);
const codigoSchema = Joi.object({ codigo: Joi.string().trim().pattern(/^\d{6}$/).required() }).unknown(true);

function pacienteIdDe(req) {
  const id = Number(req.params.pacienteId);
  if (!Number.isInteger(id)) throw new AppError('Id inválido', 400);
  return id;
}

// En ningún caso la respuesta lleva el código: solo a dónde se envió.
router.post('/:pacienteId/cedula', async (req, res, next) => {
  try {
    const pacienteId = pacienteIdDe(req);
    const { error } = cedulaSchema.validate(req.body);
    if (error) throw new AppError('Confirma que viste la cédula del titular en persona', 400);
    await verificacion.verificarConCedula(pacienteId, req.usuario);
    responder(req, res, 'Identidad verificada con la cédula');
  } catch (err) {
    next(err);
  }
});

router.post('/:pacienteId/enviar-codigo', async (req, res, next) => {
  try {
    const { contactoEnmascarado, expiraEl } = await verificacion.enviarCodigo(pacienteIdDe(req), req.usuario);
    responder(req, res, `Código enviado a ${contactoEnmascarado}`, { contactoEnmascarado, expiraEl });
  } catch (err) {
    next(err);
  }
});

router.post('/:pacienteId/confirmar-codigo', async (req, res, next) => {
  try {
    const pacienteId = pacienteIdDe(req);
    const { error, value } = codigoSchema.validate(req.body);
    if (error) throw new AppError('El código tiene 6 dígitos', 400);
    await verificacion.confirmarCodigo(pacienteId, value.codigo, req.usuario);
    responder(req, res, 'Identidad verificada con el código');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
