const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/usuarioViewController');

const router = express.Router();

router.use(requireAuth, attachUsuario, requirePermission('admin.users'));
router.get('/', controller.index);
router.post('/', controller.crear);
router.get('/:id/editar', controller.editarForm);
router.post('/:id/editar', controller.editar);

module.exports = router;
