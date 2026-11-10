// Vuelve a aplicar las supresiones, los bloqueos y las revocaciones anotados en
// registro/supresiones.jsonl (ver services/anotacionService.js y
// services/supresionService.js). Lo ejecuta ops/restaurar-db.sh después
// de restaurar un respaldo; también se puede correr a mano, con el dueño de la
// base (volver a eliminar a un paciente depurado no lo puede hacer la app):
//   docker compose run --rm -T migraciones npm run supresiones:reaplicar
// Solo informa a cuántos pacientes tuvo que corregir, nunca a quiénes.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { reaplicar } = require('./services/supresionService');

reaplicar()
  .then((resumen) => logger.info(resumen, 'Supresiones reaplicadas'))
  .catch((err) => {
    logger.error({ err }, 'No se pudieron reaplicar las supresiones');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
