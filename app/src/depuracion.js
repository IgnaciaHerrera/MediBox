// Elimina de verdad lo bloqueado que cumplió el plazo legal de conservación
// (15 años desde la última atención, Ley 20.584, art. 13; ver
// services/depuracionService.js). La aplicación no puede borrar pacientes: se
// corre con el dueño de la base, y en dos pasos.
//
// 1. Sin opciones, solo lista los candidatos (id, última atención y por qué
//    está bloqueado; nunca nombres) y no elimina nada:
//      docker compose run --rm migraciones npm run depuracion
// 2. Con --confirmar y la cuenta de privacidad que lo autoriza, los elimina:
//      docker compose run --rm migraciones npm run depuracion -- --confirmar --autoriza privacidad@dominio [--solo 12,15]
//    --solo limita la eliminación a esos ids.
require('dotenv').config();
const { logger } = require('./lib/logger');
const { prisma } = require('./lib/prisma');
const { candidatos, depurar, ANIOS_FICHA } = require('./services/depuracionService');

const argumentos = process.argv.slice(2);
const valorDe = (opcion) => {
  const i = argumentos.indexOf(opcion);
  return i === -1 ? null : String(argumentos[i + 1] || '').trim();
};
const confirmar = argumentos.includes('--confirmar');
const correo = (valorDe('--autoriza') || '').toLowerCase();
const solo = valorDe('--solo');
const soloIds = solo === null ? undefined : solo.split(',').map(Number);

const uso = () => {
  process.stderr.write('Uso: npm run depuracion -- [--confirmar --autoriza privacidad@dominio] [--solo id,id]\n');
  process.exit(2);
};
if (soloIds && soloIds.some((n) => !Number.isInteger(n) || n <= 0)) uso();
if (confirmar && !correo) uso();

async function ejecutar() {
  if (!confirmar) {
    const lista = await candidatos(new Date(), { soloIds });
    process.stdout.write(`Pacientes bloqueados con más de ${ANIOS_FICHA} años desde su última atención: ${lista.length}\n`);
    lista.forEach((c) => process.stdout.write(`  paciente ${c.pacienteId} · última atención ${c.ultimaAtencion} · ${c.origen || 'sin solicitud'}\n`));
    if (lista.length > 0) process.stdout.write('No se eliminó nada. Para eliminarlos: --confirmar --autoriza <correo de privacidad>\n');
    return;
  }
  const usuario = await prisma.usuario.findUnique({ where: { email: correo }, select: { id: true } });
  if (!usuario) {
    process.stderr.write('No existe una cuenta con ese correo\n');
    process.exitCode = 1;
    return;
  }
  const resultado = await depurar({ autorizadoPorId: usuario.id, soloIds });
  logger.info({ eliminados: resultado.eliminados, anteriorA: resultado.anteriorA }, 'Pacientes depurados');
  process.stdout.write(`Pacientes eliminados: ${resultado.eliminados}\n`);
}

ejecutar()
  .catch((err) => {
    logger.error({ err }, 'No se pudo depurar');
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
