// Preserva la evidencia de un incidente antes de contenerlo (ver
// services/incidenteService.preservarEvidencia): copia la auditoría de la
// ventana a registro/evidencias/, fuera de la base, y deja su SHA-256 en la
// auditoría. Uso:
//   docker compose exec -T app npm run incidente:evidencia -- --desde 2026-10-01 --hasta 2026-10-16 [--usuario 12]
require('dotenv').config();
const { prisma } = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { preservarEvidencia } = require('./services/incidenteService');

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const desde = argumento('desde');
const hasta = argumento('hasta');
const usuario = argumento('usuario');

if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) {
  process.stderr.write('Uso: npm run incidente:evidencia -- --desde AAAA-MM-DD --hasta AAAA-MM-DD [--usuario N]\n');
  process.exit(2);
}

preservarEvidencia({ desde: new Date(`${desde}T00:00:00`), hasta: new Date(`${hasta}T23:59:59.999`), usuarioId: usuario ? Number(usuario) : undefined })
  .then((r) => process.stdout.write(`Evidencia: ${r.archivo}\nFilas de auditoría: ${r.filas}; sesiones: ${r.sesiones}\nSHA-256: ${r.sha256}\n`))
  .catch((err) => {
    logger.error({ err }, 'No se pudo preservar la evidencia');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
