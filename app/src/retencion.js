// Aplica los plazos de conservación (ver services/retencionService.js).
//
// Pensado para correrse una vez al día desde el cron del servidor:
//   docker compose exec -T app npm run retencion
// Solo informa cuántos registros tocó, nunca qué datos.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { aplicarRetencion } = require('./services/retencionService');

aplicarRetencion()
  .then((resumen) => logger.info(resumen, 'Plazos de conservación aplicados'))
  .catch((err) => {
    logger.error({ err }, 'No se pudieron aplicar los plazos de conservación');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
