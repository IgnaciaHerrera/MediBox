const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/espacioController');

const router = express.Router();

router.use(requireAuth, attachUsuario);

router.get('/pasillos', requirePermission('box.read'), controller.listarPasillos);
router.post('/pasillos', requirePermission('box.write'), controller.crearPasillo);
router.patch('/pasillos/:id', requirePermission('box.write'), controller.actualizarPasillo);
router.delete('/pasillos/:id', requirePermission('box.write'), controller.eliminarPasillo);
router.get('/boxes', requirePermission('box.read'), controller.listarBoxes);
router.post('/boxes', requirePermission('box.write'), controller.crearBox);
router.patch('/boxes/:id', requirePermission('box.write'), controller.actualizarBox);
router.delete('/boxes/:id', requirePermission('box.write'), controller.eliminarBox);
router.get('/boxes/:boxId/instrumentos', requirePermission('box.detalle.read'), controller.listarInstrumentos);
router.post('/boxes/:boxId/instrumentos', requirePermission('box.detalle.write'), controller.crearInstrumento);
router.delete('/boxes/:boxId/instrumentos/:id', requirePermission('box.detalle.write'), controller.eliminarInstrumento);

module.exports = router;
