// Estima el alcance de un incidente desde la auditoría (ver
// services/incidenteService.js), para llenar la notificación a la Agencia y
// a los titulares. Uso:
//   docker compose exec -T app npm run incidente:alcance -- --desde 2026-10-01 --hasta 2026-10-16 [--usuario 12] [--ids]
// Sin --ids no muestra a ningún titular: solo conteos.
require('dotenv').config();
const { prisma } = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { estimarAlcance } = require('./services/incidenteService');

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const desde = argumento('desde');
const hasta = argumento('hasta');
const usuario = argumento('usuario');

if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) {
  process.stderr.write('Uso: npm run incidente:alcance -- --desde AAAA-MM-DD --hasta AAAA-MM-DD [--usuario N] [--ids]\n');
  process.exit(2);
}

estimarAlcance({
  desde: new Date(`${desde}T00:00:00`),
  hasta: new Date(`${hasta}T23:59:59.999`),
  usuarioId: usuario ? Number(usuario) : undefined,
  conIds: process.argv.includes('--ids'),
})
  .then((alcance) => process.stdout.write(`${JSON.stringify(alcance, null, 2)}\n`))
  .catch((err) => {
    logger.error({ err }, 'No se pudo estimar el alcance del incidente');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
