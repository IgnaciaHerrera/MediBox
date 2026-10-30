// Invita a responder la encuesta de satisfacción a quienes se atendieron
// ayer (ver services/recordatorioService.js), solo si tienen vigente ese
// consentimiento.
//
// Pensado para correrse una vez al día desde el cron del servidor:
//   docker compose exec -T app npm run encuestas
// Solo informa cuántos mensajes envió, nunca a quién.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { enviarInvitacionesEncuesta } = require('./services/recordatorioService');

enviarInvitacionesEncuesta()
  .then((resumen) => logger.info(resumen, 'Invitaciones a la encuesta enviadas'))
  .catch((err) => {
    logger.error({ err }, 'No se pudieron enviar las invitaciones a la encuesta');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
