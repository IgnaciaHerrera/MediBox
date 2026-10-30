// Revisa las últimas 24 horas de auditoría con las reglas de
// services/alertasService.js y avisa a quienes auditan si hay alertas.
// Además avisa a privacidad cuántas solicitudes de derechos están vencidas
// o por vencer (services/derechosService.js).
//
// Pensado para correrse una vez al día (o cada hora) desde el cron:
//   docker compose exec -T app npm run alertas
// Solo informa cuántas alertas hubo, nunca sobre quién.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { notificarAlertas } = require('./services/alertasService');
const { avisarVencimientos } = require('./services/derechosService');

notificarAlertas()
  .then((resumen) => logger.info(resumen, 'Alertas revisadas'))
  .then(() => avisarVencimientos())
  .then((resumen) => logger.info(resumen, 'Vencimientos de solicitudes revisados'))
  .catch((err) => {
    logger.error({ err }, 'No se pudieron revisar las alertas');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
