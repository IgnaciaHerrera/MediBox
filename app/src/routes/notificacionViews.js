const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/notificacionViewController');

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación.
router.use(requireAuth, attachUsuario, requirePermission('notificaciones.read'));

router.get('/', controller.index);
router.post('/marcar-todas', controller.marcarTodas);
router.post('/:id/leida', controller.marcarLeida);

module.exports = router;
