const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission, requireAnyPermission } = require('../middleware/requirePermission');
const controller = require('../controllers/agendaViewController');

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación.
router.use(requireAuth, attachUsuario, requirePermission('agenda.read'));

router.get('/', controller.index);
router.get('/mia', controller.mia);
// Agendar exige además poder leer pacientes: el formulario lista a todos.
router.get('/nueva', requirePermission('agenda.write'), requirePermission('paciente.read'), controller.nuevaForm);
router.post('/nueva', requirePermission('agenda.write'), requirePermission('paciente.read'), controller.crear);
router.get('/:id', controller.detalle);
// El médico registra la atención de sus propias citas; citaService lo verifica.
router.post('/:id/estado', requireAnyPermission('agenda.write', 'agenda.estado.propias'), controller.cambiarEstado);
router.post('/:id/anular', requirePermission('agenda.write'), controller.anular);

module.exports = router;
