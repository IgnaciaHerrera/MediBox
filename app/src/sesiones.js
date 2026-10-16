// Contención de una cuenta comprometida (plan de respuesta, Hito 3): cierra
// todas las sesiones abiertas de esa cuenta, sin cerrar las del resto del
// personal. Uso:
//   docker compose exec -T app npm run sesiones:cerrar -- --correo operador@medibox.local
require('dotenv').config();
const { prisma } = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { cerrarSesionesDe } = require('./services/sesionService');

const i = process.argv.indexOf('--correo');
const correo = i === -1 ? '' : String(process.argv[i + 1] || '').trim().toLowerCase();
if (!correo) {
  process.stderr.write('Uso: npm run sesiones:cerrar -- --correo cuenta@dominio\n');
  process.exit(2);
}

prisma.usuario
  .findUnique({ where: { email: correo }, select: { id: true } })
  .then(async (usuario) => {
    if (!usuario) {
      process.stderr.write('No existe una cuenta con ese correo\n');
      process.exitCode = 1;
      return;
    }
    const cerradas = await cerrarSesionesDe(usuario.id, { actor: 'sistema' });
    process.stdout.write(`Sesiones cerradas: ${cerradas}\n`);
  })
  .catch((err) => {
    logger.error({ err }, 'No se pudieron cerrar las sesiones');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
