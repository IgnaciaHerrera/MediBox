const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/medicoViewController');

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación.
router.use(requireAuth, attachUsuario, requirePermission('medicos.read'));

router.get('/', controller.index);
router.post('/especialidades', requirePermission('admin.system'), controller.crearEspecialidad);
router.post('/especialidades/:id', requirePermission('admin.system'), controller.editarEspecialidad);
router.post('/especialidades/:id/eliminar', requirePermission('admin.system'), controller.eliminarEspecialidad);
router.post('/', requirePermission('admin.system'), controller.crearMedico);
router.post('/:id/eliminar', requirePermission('admin.system'), controller.eliminarMedico);
router.post('/:id/editar', requirePermission('admin.system'), controller.editarMedico);

module.exports = router;
