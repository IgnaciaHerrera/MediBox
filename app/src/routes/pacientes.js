const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/pacienteController');

const router = express.Router();

router.use(requireAuth, attachUsuario);
router.get('/', requirePermission('paciente.read'), controller.index);
router.get('/:id', requirePermission('paciente.read'), controller.show);
router.post('/', requirePermission('paciente.write'), controller.store);

module.exports = router;
