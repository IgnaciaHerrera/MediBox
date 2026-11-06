// Compara la auditoría de la base con su copia externa (ver
// services/auditoriaCopiaService.js). Se programa una vez al día:
//   docker compose exec -T app npm run auditoria:verificar
// Sale con código 1 si encontró filas eliminadas, alteradas o agregadas
// después; la próxima revisión de alertas lo informa como crítico.
require('dotenv').config();
const { prisma } = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { verificar } = require('./services/auditoriaCopiaService');

verificar()
  .then((r) => {
    if (r.hallazgos.length > 0) {
      logger.error(
        { ...r, hallazgos: r.hallazgos.slice(0, 50) },
        'La auditoría no coincide con su copia',
      );
      process.exitCode = 1;
    } else {
      logger.info(r, 'La auditoría coincide con su copia');
    }
  })
  .catch((err) => {
    logger.error({ err }, 'No se pudo verificar la auditoría');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
