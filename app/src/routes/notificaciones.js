const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/notificacionController');

const router = express.Router();

router.use(requireAuth, attachUsuario, requirePermission('notificaciones.read'));
router.get('/', controller.index);
router.patch('/marcar-todas', controller.marcarTodasLeidas);
router.patch('/:id/leida', controller.marcarLeida);

module.exports = router;
