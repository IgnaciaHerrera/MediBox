const express = require('express');
const rateLimit = require('express-rate-limit');
const { registrar } = require('../services/auditService');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/solicitudViewController');

const router = express.Router();

// Solicitudes de derechos: las resuelve el rol de privacidad.
router.use(requireAuth, attachUsuario, requirePermission('derechos.gestionar'));

router.get('/', controller.index);
// La reautenticación prueba la contraseña: con una sesión robada no se puede
// usar para adivinarla. Mismo criterio que el inicio de sesión.
const reautenticacionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (req, res, next, options) => {
    try {
      await registrar({ usuarioId: req.usuario.id, accion: 'REAUTENTICAR_LIMITADO', entidad: 'Usuario', entidadId: req.usuario.id, resultado: 'denegado' });
      res.status(options.statusCode).json({ error: 'Demasiados intentos: espera antes de volver a confirmar tu contraseña' });
    } catch (err) {
      next(err);
    }
  },
});

router.post('/reautenticar', reautenticacionLimiter, controller.reautenticar);
router.get('/:id', controller.detalle);
router.post('/:id/verificar', controller.verificar);
router.post('/:id/ejecutar', controller.ejecutar);
router.post('/:id/rechazar', controller.rechazar);
router.post('/:id/desbloquear', controller.desbloquear);
router.post('/:id/nueva', controller.nueva);
router.post('/:id/descargar', controller.descargar);

module.exports = router;
