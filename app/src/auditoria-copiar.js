// Copia la auditoría nueva al almacenamiento externo (ver
// services/auditoriaCopiaService.js). Se programa cada 15 minutos:
//   docker compose exec -T app npm run auditoria:copiar
// Informa cuántas filas copió, en qué archivos y el desfase de los relojes.
require('dotenv').config();
const { prisma } = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { copiar } = require('./services/auditoriaCopiaService');

copiar()
  .then((r) => logger.info(r, 'Auditoría copiada'))
  .catch((err) => {
    logger.error({ err }, 'No se pudo copiar la auditoría');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
