// Envía los recordatorios de las citas de mañana (ver
// services/recordatorioService.js), solo a quienes tienen vigente ese
// consentimiento.
//
// Pensado para correrse una vez al día desde el cron del servidor:
//   docker compose exec -T app npm run recordatorios
// Solo informa cuántos mensajes envió, nunca a quién.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { enviarRecordatorios } = require('./services/recordatorioService');

enviarRecordatorios()
  .then((resumen) => logger.info(resumen, 'Recordatorios enviados'))
  .catch((err) => {
    logger.error({ err }, 'No se pudieron enviar los recordatorios');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
