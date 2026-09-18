const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/medicoController');

const router = express.Router();

router.use(requireAuth, attachUsuario);
router.get('/', requirePermission('medicos.read'), controller.index);
router.post('/', requirePermission('admin.system'), controller.store);

module.exports = router;
