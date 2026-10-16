// Revisa las últimas 24 horas de auditoría con las reglas de
// services/alertasService.js y avisa a quienes auditan si hay alertas.
//
// Pensado para correrse una vez al día (o cada hora) desde el cron:
//   docker compose exec -T app npm run alertas
// Solo informa cuántas alertas hubo, nunca sobre quién.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { notificarAlertas } = require('./services/alertasService');

notificarAlertas()
  .then((resumen) => logger.info(resumen, 'Alertas revisadas'))
  .catch((err) => {
    logger.error({ err }, 'No se pudieron revisar las alertas');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
