// Rota una llave de cifrado (ver services/rotacionService.js). Procedimiento,
// con la app detenida (docker compose stop app):
//   1. Respalda la base (ops/respaldar-db.sh).
//   2. En .env, copia la llave actual a <VARIABLE>_ANTERIOR y pon la nueva
//      en <VARIABLE> (generada con: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").
//   3. docker compose run --rm app npm run llaves:rotar -- --variable <VARIABLE>
//   4. Borra <VARIABLE>_ANTERIOR del .env y levanta la app.
// Solo informa cuántas filas reescribió, nunca valores ni llaves.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { rotar, ROTABLES } = require('./services/rotacionService');

const i = process.argv.indexOf('--variable');
const variable = i === -1 ? undefined : process.argv[i + 1];
if (!ROTABLES.includes(variable)) {
  process.stderr.write(`Uso: npm run llaves:rotar -- --variable <${ROTABLES.join('|')}>\n`);
  process.exit(2);
}

const decodificar = (nombre) => Buffer.from((process.env[nombre] || '').trim(), 'base64');

rotar(variable, { llaveAnterior: decodificar(`${variable}_ANTERIOR`), llaveNueva: decodificar(variable) })
  .then((resumen) => logger.info({ variable, ...resumen }, 'Llave rotada: borra la llave anterior del .env'))
  .catch((err) => {
    // El mensaje nombra variables, nunca valores.
    logger.error({ variable, mensaje: err.message }, 'No se pudo rotar la llave: no se cambió nada');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
