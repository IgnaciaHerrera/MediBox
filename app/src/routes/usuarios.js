const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/usuarioController');

const router = express.Router();

router.use(requireAuth, attachUsuario, requirePermission('admin.users'));
router.get('/', controller.index);
router.get('/:id', controller.show);
router.post('/', controller.store);
router.patch('/:id', controller.update);

module.exports = router;
