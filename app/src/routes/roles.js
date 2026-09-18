const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/rolController');

const router = express.Router();

router.use(requireAuth, attachUsuario, requirePermission('admin.roles'));
router.get('/', controller.index);
router.patch('/:id', controller.update);

module.exports = router;
