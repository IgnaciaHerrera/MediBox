const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/auditoriaController');

const router = express.Router();

router.use(requireAuth, attachUsuario, requirePermission('auditoria.read'));
router.get('/', controller.index);

module.exports = router;
