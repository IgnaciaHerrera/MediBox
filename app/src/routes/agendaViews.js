const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/agendaViewController');

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación.
router.use(requireAuth, attachUsuario, requirePermission('agenda.read'));

router.get('/', controller.index);
router.get('/mia', controller.mia);
router.get('/nueva', requirePermission('agenda.write'), controller.nuevaForm);
router.post('/nueva', requirePermission('agenda.write'), controller.crear);
router.get('/:id', controller.detalle);
router.post('/:id/estado', requirePermission('agenda.write'), controller.cambiarEstado);
router.post('/:id/anular', requirePermission('agenda.write'), controller.anular);

module.exports = router;
