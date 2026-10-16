const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission, requireAnyPermission } = require('../middleware/requirePermission');
const controller = require('../controllers/citaController');

const router = express.Router();

router.use(requireAuth, attachUsuario);
router.get('/', requirePermission('agenda.read'), controller.index);
router.get('/conflicto', requirePermission('agenda.write'), controller.conflicto);
router.post('/', requirePermission('agenda.write'), controller.store);
// El médico registra la atención de sus propias citas; citaService lo verifica.
router.patch('/:id/estado', requireAnyPermission('agenda.write', 'agenda.estado.propias'), controller.actualizarEstado);
router.delete('/:id', requirePermission('agenda.write'), controller.anular);

module.exports = router;
