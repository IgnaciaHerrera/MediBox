const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission, requireAnyPermission } = require('../middleware/requirePermission');
const controller = require('../controllers/pacienteViewController');

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación.
// El médico ('paciente.read.propios') entra, pero pacienteService le acota
// la lectura a sus propios pacientes.
router.use(requireAuth, attachUsuario, requireAnyPermission('paciente.read', 'paciente.read.propios'));

router.get('/', controller.index);
router.get('/nuevo', requirePermission('paciente.write'), controller.nuevaForm);
router.post('/nuevo', requirePermission('paciente.write'), controller.crear);
router.get('/:id/editar', requirePermission('paciente.write'), controller.editarForm);
router.post('/:id/editar', requirePermission('paciente.write'), controller.editar);
router.post('/:id/consentimientos/:clave/otorgar', requirePermission('consentimiento.write'), controller.otorgarConsentimiento);
router.post('/:id/consentimientos/:clave/revocar', requirePermission('consentimiento.write'), controller.revocarConsentimiento);
router.post('/:id/solicitudes', requirePermission('derechos.registrar'), controller.registrarSolicitud);
router.post('/:id/solicitudes/:sid/verificar', requirePermission('derechos.registrar'), controller.verificarSolicitud);
router.get('/:id', controller.detalle);

module.exports = router;
