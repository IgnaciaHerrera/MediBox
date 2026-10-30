const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/incidenteViewController');

const router = express.Router();

// El registro de incidentes lo llevan el gestor y privacidad. No hay ruta
// para borrar: un incidente se descarta o se cierra, nunca desaparece.
router.use(requireAuth, attachUsuario, requirePermission('incidentes.gestionar'));
router.get('/', controller.index);
router.post('/', controller.crear);
router.get('/:id', controller.detalle);
router.post('/:id', controller.actualizar);
router.post('/:id/estado', controller.cambiarEstado);

module.exports = router;
