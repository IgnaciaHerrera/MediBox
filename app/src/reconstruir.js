// Reconstruye desde la auditoría lo que hizo una cuenta en un período, y los
// intentos contra ella (ver services/incidenteService.reconstruir). Sirve
// para investigar un incidente y para comprobar, en un simulacro, que los
// registros alcanzan. Uso:
//   docker compose exec -T app npm run incidente:reconstruir -- --correo operador@medibox.local --desde 2026-11-06T09:00 --hasta 2026-11-06T12:00 [--incidente N] [--json]
// Imprime una línea por evento (hora, acción, sobre qué, resultado, IP) y un
// resumen. Los pacientes aparecen solo por su id interno.
require('dotenv').config();
const { prisma } = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { reconstruir } = require('./services/incidenteService');
const { incidenteDeArgumentos } = require('./lib/argumentos');
const { isoLocal } = require('./lib/fecha');

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const FECHA = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const correo = String(argumento('correo') || '')
  .trim()
  .toLowerCase();
const desde = argumento('desde');
const hasta = argumento('hasta');
if (!correo || !FECHA.test(desde || '') || !FECHA.test(hasta || '')) {
  process.stderr.write(
    'Uso: npm run incidente:reconstruir -- --correo cuenta@dominio --desde AAAA-MM-DD[THH:MM] --hasta AAAA-MM-DD[THH:MM] [--incidente N] [--json]\n',
  );
  process.exit(2);
}
const aFecha = (texto, finDelDia) =>
  new Date(
    texto.includes('T') ? `${texto}:00` : `${texto}T${finDelDia ? '23:59:59.999' : '00:00:00'}`,
  );

prisma.usuario
  .findUnique({ where: { email: correo }, select: { id: true } })
  .then(async (usuario) => {
    if (!usuario) {
      process.stderr.write('No existe una cuenta con ese correo\n');
      process.exitCode = 1;
      return;
    }
    const r = await reconstruir({
      desde: aFecha(desde, false),
      hasta: aFecha(hasta, true),
      usuarioId: usuario.id,
      incidenteId: incidenteDeArgumentos(),
    });
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return;
    }
    for (const e of r.eventos) {
      const sobre = `${e.entidad}${e.entidadId ? ` ${e.entidadId}` : ''}`;
      process.stdout.write(
        `${isoLocal(e.timestamp)}  ${e.accion.padEnd(24)} ${sobre.padEnd(16)} ${e.resultado.padEnd(9)} ${e.ip || '-'}\n`,
      );
    }
    process.stdout.write(
      `\n${JSON.stringify(r.resumen, null, 2)}\n${r.truncado ? 'Se muestran los primeros 2.000 eventos.\n' : ''}`,
    );
  })
  .catch((err) => {
    logger.error({ err }, 'No se pudo reconstruir lo ocurrido');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
