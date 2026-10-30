// Contención de una cuenta comprometida (plan de respuesta a incidentes):
// la suspende, para que no pueda volver a iniciar sesión aunque el atacante
// conozca la contraseña, y cierra sus sesiones abiertas. Con --reactivar, la
// devuelve a la normalidad cuando el incidente se cerró. Uso:
//   docker compose exec -T app npm run cuenta:suspender -- --correo operador@medibox.local [--reactivar]
require('dotenv').config();
const { prisma } = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { cambiarSuspension } = require('./services/usuarioService');

const i = process.argv.indexOf('--correo');
const correo = i === -1 ? '' : String(process.argv[i + 1] || '').trim().toLowerCase();
const reactivar = process.argv.includes('--reactivar');
if (!correo) {
  process.stderr.write('Uso: npm run cuenta:suspender -- --correo cuenta@dominio [--reactivar]\n');
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
    const { cerradas } = await cambiarSuspension(usuario.id, !reactivar, { actor: 'sistema' });
    process.stdout.write(reactivar ? 'Cuenta reactivada\n' : `Cuenta suspendida; sesiones cerradas: ${cerradas}\n`);
  })
  .catch((err) => {
    logger.error({ err }, 'No se pudo cambiar la suspensión de la cuenta');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
