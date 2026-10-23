const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { attachUsuario } = require('../middleware/attachUsuario');
const { requirePermission } = require('../middleware/requirePermission');
const controller = require('../controllers/datosViewController');

const router = express.Router();

router.use(requireAuth, attachUsuario);

// La página de índice se muestra si el usuario tiene alguno de los dos
// permisos de datos; cada sección visible dentro de ella depende del que
// corresponda.
router.get('/', (req, res, next) => {
  if (!req.usuario.permisos.includes('data.export') && !req.usuario.permisos.includes('data.import')) {
    return res.status(403).json({ error: 'Permiso insuficiente' });
  }
  return next();
}, controller.index);

// Cada exportación exige data.export además del permiso de lectura de la
// entidad correspondiente: un data.export aislado no basta para leer datos
// que el rol no podría leer por otra vía. El reporte de pacientes es la
// excepción: está seudonimizado y no identifica a nadie. La estadística es
// anónima: agregada, sin seudónimo y con los grupos pequeños suprimidos.
router.get('/exportar/pacientes.csv', requirePermission('data.export'), controller.exportarPacientes);
router.get('/exportar/estadistica.csv', requirePermission('data.export'), controller.exportarEstadistica);
router.get('/exportar/investigacion.csv', requirePermission('data.export'), controller.exportarInvestigacion);
router.get(
  '/exportar/citas.csv',
  requirePermission('data.export'),
  requirePermission('agenda.read'),
  controller.exportarCitas,
);
router.get(
  '/exportar/auditoria.csv',
  requirePermission('data.export'),
  requirePermission('auditoria.read'),
  controller.exportarAuditoria,
);

// La importación de espacios exige además box.write: data.import por sí solo
// no debe alcanzar para crear entidades que el rol no podría crear a mano.
router.post(
  '/importar/espacios',
  requirePermission('data.import'),
  requirePermission('box.write'),
  controller.importarEspacios,
);

module.exports = router;
