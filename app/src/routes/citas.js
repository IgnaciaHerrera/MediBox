const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/citaController');

const router = express.Router();

router.use(requireAuth, attachUsuario);
router.get('/', requirePermission('agenda.read'), controller.index);
router.get('/conflicto', requirePermission('agenda.write'), controller.conflicto);
router.post('/', requirePermission('agenda.write'), controller.store);
router.patch('/:id/estado', requirePermission('agenda.write'), controller.actualizarEstado);
router.delete('/:id', requirePermission('agenda.write'), controller.anular);

module.exports = router;
