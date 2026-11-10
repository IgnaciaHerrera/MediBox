// Revisa las últimas 24 horas de auditoría con las reglas de
// services/alertasService.js y avisa a quienes auditan si hay alertas.
// Además avisa a privacidad cuántas solicitudes de derechos están vencidas
// o por vencer (services/derechosService.js).
//
// Lo corre el servicio `tareas` (lib/programador.js): la detección cada hora y
// los vencimientos una vez al día, porque cada aviso es una notificación a
// privacidad y no se deduplica. A mano hace las dos cosas:
//   docker compose exec -T app npm run alertas
//   docker compose exec -T app npm run alertas -- --solo-alertas
//   docker compose exec -T app npm run alertas -- --solo-vencimientos
// Solo informa cuántas alertas hubo, nunca sobre quién.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { notificarAlertas } = require('./services/alertasService');
const { avisarVencimientos } = require('./services/derechosService');

const argumentos = process.argv.slice(2);
const conAlertas = !argumentos.includes('--solo-vencimientos');
const conVencimientos = !argumentos.includes('--solo-alertas');

async function revisar() {
  if (conAlertas) logger.info(await notificarAlertas(), 'Alertas revisadas');
  if (conVencimientos) logger.info(await avisarVencimientos(), 'Vencimientos de solicitudes revisados');
}

revisar()
  .catch((err) => {
    logger.error({ err }, 'No se pudieron revisar las alertas');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
