const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/espacioViewController');

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación.
router.use(requireAuth, attachUsuario, requirePermission('box.read'));

router.get('/', controller.index);
router.post('/pasillos', requirePermission('box.write'), controller.crearPasillo);
router.post('/pasillos/:id', requirePermission('box.write'), controller.editarPasillo);
router.post('/pasillos/:id/eliminar', requirePermission('box.write'), controller.eliminarPasillo);
router.post('/boxes', requirePermission('box.write'), controller.crearBox);
router.get('/boxes/:id', requirePermission('box.detalle.read'), controller.boxDetalle);
router.post('/boxes/:id', requirePermission('box.write'), controller.actualizarBox);
router.post('/boxes/:id/eliminar', requirePermission('box.write'), controller.eliminarBox);
router.post('/boxes/:id/instrumentos', requirePermission('box.detalle.write'), controller.nuevoInstrumento);
router.post('/boxes/:id/instrumentos/:instrumentoId/eliminar', requirePermission('box.detalle.write'), controller.eliminarInstrumento);

module.exports = router;
