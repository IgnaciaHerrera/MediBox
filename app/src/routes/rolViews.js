const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/rolViewController');

const router = express.Router();

router.use(requireAuth, attachUsuario, requirePermission('admin.roles'));
router.get('/', controller.index);
router.post('/actualizar-todo', controller.actualizarTodo);

module.exports = router;
