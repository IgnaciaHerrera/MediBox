const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission, requireAnyPermission } = require('../middleware/requirePermission');
const controller = require('../controllers/pacienteController');

const router = express.Router();

router.use(requireAuth, attachUsuario);
// El médico ('paciente.read.propios') entra, pero pacienteService le acota
// la lectura a sus propios pacientes.
const puedeLeer = requireAnyPermission('paciente.read', 'paciente.read.propios');
router.get('/', puedeLeer, controller.index);
router.get('/:id', puedeLeer, controller.show);
router.post('/', requirePermission('paciente.write'), controller.store);
router.patch('/:id', requirePermission('paciente.write'), controller.update);

module.exports = router;
