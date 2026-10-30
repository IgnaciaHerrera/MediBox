// Elimina la auditoría que ya cumplió sus 15 años de conservación (ver
// services/auditService.purgarVencidos). La aplicación no tiene permiso
// para borrar audit_log: se corre con el dueño de la base, una vez al año:
//   docker compose run --rm migraciones npm run auditoria:purgar
// Solo informa cuántas filas eliminó.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { purgarVencidos } = require('./services/auditService');

purgarVencidos()
  .then((resumen) => logger.info(resumen, 'Auditoría vencida eliminada'))
  .catch((err) => {
    logger.error({ err }, 'No se pudo eliminar la auditoría vencida');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
