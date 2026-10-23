const { prisma } = require('../lib/prisma');
const canalEnvio = require('../lib/canalEnvio');
const { hoyISO, fechaDMA } = require('../lib/fecha');
const { registrar } = require('./auditService');
const { pacientesConVigente } = require('./consentimientoService');
const { contactosParaProceso } = require('./pacienteService');

// Recordatorio automático de citas: una finalidad que requiere
// consentimiento (D1). El aviso de un cambio o una anulación no pasa por
// aquí: tiene base legal y se envía igual.

function mananaISO() {
  const fecha = new Date(`${hoyISO()}T12:00:00`);
  fecha.setDate(fecha.getDate() + 1);
  return fecha.toISOString().slice(0, 10);
}

/**
 * Envía un recordatorio por cada cita agendada del día indicado, solo a los
 * pacientes que en este momento tienen vigente el consentimiento
 * 'recordatorios' y un contacto registrado. El mensaje lleva solo la fecha y
 * la hora: ni el médico, ni la especialidad, ni el motivo.
 *
 * @param {{fecha?: string}} [opciones] - AAAA-MM-DD; por omisión, mañana.
 * @returns {Promise<{enviados: number, sinCanal: number}>}
 *
 * Consumidores: src/recordatorios.js (npm run recordatorios).
 */
async function enviarRecordatorios({ fecha = mananaISO() } = {}) {
  const autorizados = new Set(await pacientesConVigente('recordatorios'));
  const citas = await prisma.cita.findMany({
    where: { fecha: new Date(fecha), anulada: false, estado: 'agendada', pacienteId: { in: [...autorizados] }, paciente: { bloqueado: false } },
    select: { pacienteId: true, horaInicio: true },
    orderBy: { horaInicio: 'asc' },
  });
  const contactos = await contactosParaProceso(citas.map((c) => c.pacienteId));

  let enviados = 0;
  let sinCanal = 0;
  for (const cita of citas) {
    const contacto = contactos.get(cita.pacienteId);
    if (!contacto) continue;
    try {
      await canalEnvio.enviar(contacto, `Recordatorio de MediBox: tiene una cita el ${fechaDMA(fecha)} a las ${cita.horaInicio}.`);
      enviados += 1;
    } catch {
      sinCanal += 1;
    }
  }

  const resumen = { enviados, sinCanal };
  await registrar({ actor: 'sistema', accion: 'RECORDATORIO', entidad: 'Sistema', entidadId: 0, detalle: resumen });
  return resumen;
}

module.exports = { enviarRecordatorios };
