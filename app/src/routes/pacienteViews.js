const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/pacienteViewController');

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación.
router.use(requireAuth, attachUsuario, requirePermission('paciente.read'));

router.get('/', controller.index);
router.get('/nuevo', requirePermission('paciente.write'), controller.nuevaForm);
router.post('/nuevo', requirePermission('paciente.write'), controller.crear);
router.get('/:id/editar', requirePermission('paciente.write'), controller.editarForm);
router.post('/:id/editar', requirePermission('paciente.write'), controller.editar);
router.get('/:id', controller.detalle);

module.exports = router;
