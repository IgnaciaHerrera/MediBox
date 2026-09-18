const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/espacioController');

const router = express.Router();

router.use(requireAuth, attachUsuario);

router.get('/pasillos', requirePermission('box.read'), controller.listarPasillos);
router.get('/boxes', requirePermission('box.read'), controller.listarBoxes);
router.post('/boxes', requirePermission('box.write'), controller.crearBox);
router.get('/boxes/:boxId/instrumentos', requirePermission('box.detalle.read'), controller.listarInstrumentos);
router.post('/boxes/:boxId/instrumentos', requirePermission('box.detalle.write'), controller.crearInstrumento);

module.exports = router;
