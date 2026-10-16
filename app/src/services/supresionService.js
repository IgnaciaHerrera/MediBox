const fs = require('fs');
const path = require('path');
const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');

// Supresiones que sobreviven a una restauración (Hito 3).
//
// Los respaldos cifrados no se editan: rotan a los 30 días
// (ops/respaldar-db.sh), así que lo suprimido desaparece de ellos en ese
// plazo. Mientras tanto, restaurar uno anterior resucitaría el contacto de
// quien pidió suprimirlo. Por eso cada supresión queda anotada en un archivo
// fuera de la base y de sus respaldos (solo ids y fecha, sin datos
// personales), y ops/restaurar-db.sh la vuelve a aplicar al terminar.

function archivo() {
  return process.env.SUPRESIONES_ARCHIVO || path.join(__dirname, '..', '..', 'registro', 'supresiones.jsonl');
}

/**
 * Anota una supresión ejecutada.
 *
 * @param {number} pacienteId
 * @param {number} solicitudId
 * @returns {void}
 *
 * Consumidores: derechosService.ejecutar (supresión).
 */
function registrarSupresion(pacienteId, solicitudId) {
  fs.mkdirSync(path.dirname(archivo()), { recursive: true });
  fs.appendFileSync(archivo(), `${JSON.stringify({ pacienteId, fecha: new Date().toISOString(), solicitudId })}\n`);
}

function leerSupresiones() {
  if (!fs.existsSync(archivo())) return [];
  return fs
    .readFileSync(archivo(), 'utf8')
    .split('\n')
    .filter((linea) => linea.trim())
    .map((linea) => JSON.parse(linea));
}

/**
 * Vuelve a aplicar todas las supresiones anotadas: contacto en NULL,
 * consentimientos revocados, sin representante, bloqueado y sin citas
 * futuras. Es idempotente: solo toca (y audita) a quien algo le volvió.
 *
 * @returns {Promise<{reaplicadas: number}>} pacientes que hubo que corregir.
 *
 * Consumidores: src/supresiones.js (npm run supresiones:reaplicar), que
 *   ejecuta ops/restaurar-db.sh después de restaurar.
 */
async function reaplicar() {
  const ids = [...new Set(leerSupresiones().map((s) => s.pacienteId))];
  let reaplicadas = 0;
  const hoy = new Date(new Date().toISOString().slice(0, 10));

  for (const pacienteId of ids) {
    const corregido = await prisma.$transaction(async (tx) => {
      const paciente = await tx.paciente.findUnique({ where: { id: pacienteId }, select: { contactoCifrado: true, bloqueado: true } });
      // El respaldo puede ser anterior al registro del paciente.
      if (!paciente) return false;

      const cambios = {
        contacto: paciente.contactoCifrado ? 1 : 0,
        bloqueo: paciente.bloqueado ? 0 : 1,
        consentimientos: (await tx.consentimiento.updateMany({ where: { pacienteId, revocadoEl: null }, data: { revocadoEl: new Date() } })).count,
        representantes: (await tx.consentimiento.updateMany({ where: { pacienteId, representanteCifrado: { not: null } }, data: { representanteCifrado: null } })).count,
        citas: (await tx.cita.updateMany({ where: { pacienteId, anulada: false, estado: 'agendada', fecha: { gte: hoy } }, data: { anulada: true } })).count,
      };
      if (Object.values(cambios).every((n) => n === 0)) return false;

      await tx.paciente.update({ where: { id: pacienteId }, data: { contactoCifrado: null, bloqueado: true, bloqueadoEl: new Date() } });
      await registrar({ actor: 'sistema', accion: 'REAPLICAR_SUPRESION', entidad: 'Paciente', entidadId: pacienteId, detalle: cambios }, tx);
      return true;
    });
    if (corregido) reaplicadas += 1;
  }
  return { reaplicadas };
}

module.exports = { registrarSupresion, reaplicar };
