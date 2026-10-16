const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/solicitudViewController');

const router = express.Router();

// Solicitudes de derechos: las resuelve el rol de privacidad.
router.use(requireAuth, attachUsuario, requirePermission('derechos.gestionar'));

router.get('/', controller.index);
router.post('/reautenticar', controller.reautenticar);
router.get('/:id', controller.detalle);
router.post('/:id/verificar', controller.verificar);
router.post('/:id/ejecutar', controller.ejecutar);
router.post('/:id/rechazar', controller.rechazar);
router.post('/:id/desbloquear', controller.desbloquear);
router.post('/:id/descargar', controller.descargar);

module.exports = router;
