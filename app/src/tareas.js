// Corre los procesos de operación a su hora (ver lib/programador.js). Es el
// proceso del servicio `tareas` de docker-compose.yml: se queda esperando y,
// a cada hora, lanza el script que corresponde. Los scripts se pueden seguir
// corriendo a mano con `npm run ...`.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { revisarEntorno } = require('./lib/entorno');
const { TAREAS, crearProgramador } = require('./lib/programador');

// Lo mismo que el servidor: sin una configuración completa (en producción,
// también la copia externa de la auditoría), no arranca.
const problemas = revisarEntorno();
if (problemas.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`Las tareas no arrancan: configuración insegura o incompleta.\n- ${problemas.join('\n- ')}`);
  process.exit(1);
}

const programador = crearProgramador();
programador.iniciar();
logger.info({ tareas: TAREAS.map((t) => t.nombre) }, 'Tareas programadas');

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    programador.detener();
    logger.info({ senal }, 'Tareas detenidas');
    process.exit(0);
  });
}
