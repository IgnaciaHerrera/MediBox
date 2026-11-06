const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/alertaViewController');

const router = express.Router();

// Las alertas las revisan el gestor y privacidad, cada una el rol
// responsable de su regla. Escalarlas a un incidente se hace en /incidentes.
router.use(requireAuth, attachUsuario, requirePermission('alertas.revisar'));
router.get('/', controller.index);
router.post('/analizar', controller.analizar);
router.post('/:id/descartar', controller.descartar);

module.exports = router;
