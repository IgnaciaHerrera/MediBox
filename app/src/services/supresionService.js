const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');
const { borrarContactosAnteriores } = require('./pacienteService');
const { registrarSupresion, leerAnotaciones } = require('./anotacionService');

// Reaplicación de lo que el titular ya pidió, tras restaurar un respaldo
// anterior (Hito 3). Qué se anota y por qué: ver anotacionService.js.

// Supresión: contacto en NULL, consentimientos revocados, sin representante,
// bloqueado y sin citas futuras. Es permanente.
async function reaplicarSupresion(pacienteId, tx) {
  const hoy = new Date(new Date().toISOString().slice(0, 10));
  const paciente = await tx.paciente.findUnique({ where: { id: pacienteId }, select: { contactoCifrado: true, bloqueado: true } });
  // El respaldo puede ser anterior al registro del paciente.
  if (!paciente) return false;

  const anteriores =
    (await tx.historialCambio.count({ where: { pacienteId, campo: 'contacto', valorAnteriorCifrado: { not: null } } })) +
    (await tx.solicitudDerecho.count({ where: { pacienteId, campo: 'contacto', valorPropuestoCifrado: { not: null } } }));
  await borrarContactosAnteriores([pacienteId], tx);
  const cambios = {
    contacto: paciente.contactoCifrado ? 1 : 0,
    contactosAnteriores: anteriores,
    bloqueo: paciente.bloqueado ? 0 : 1,
    consentimientos: (await tx.consentimiento.updateMany({ where: { pacienteId, revocadoEl: null }, data: { revocadoEl: new Date() } })).count,
    representantes: (await tx.consentimiento.updateMany({ where: { pacienteId, representanteCifrado: { not: null } }, data: { representanteCifrado: null } })).count,
    citas: (await tx.cita.updateMany({ where: { pacienteId, anulada: false, estado: 'agendada', fecha: { gte: hoy } }, data: { anulada: true } })).count,
  };
  if (Object.values(cambios).every((n) => n === 0)) return false;

  await tx.paciente.update({ where: { id: pacienteId }, data: { contactoCifrado: null, bloqueado: true, bloqueadoEl: new Date() } });
  await registrar({ actor: 'sistema', accion: 'REAPLICAR_SUPRESION', entidad: 'Paciente', entidadId: pacienteId, detalle: cambios }, tx);
  return true;
}

// Bloqueos, desbloqueos y revocaciones de un paciente que no ejerció la
// supresión. Manda el último bloqueo o desbloqueo anotado; una revocación solo
// cierra lo que se otorgó antes de ella, no un consentimiento nuevo.
async function reaplicarRestricciones(pacienteId, anotaciones, tx) {
  const hoy = new Date(new Date().toISOString().slice(0, 10));
  const paciente = await tx.paciente.findUnique({ where: { id: pacienteId }, select: { bloqueado: true } });
  if (!paciente) return false;

  const cambios = { bloqueo: 0, desbloqueo: 0, consentimientos: 0, citas: 0 };
  const ultimo = anotaciones.filter((a) => a.tipo === 'bloqueo' || a.tipo === 'desbloqueo').pop();
  if (ultimo && ultimo.tipo === 'bloqueo' && !paciente.bloqueado) {
    cambios.bloqueo = 1;
    cambios.citas = (await tx.cita.updateMany({ where: { pacienteId, anulada: false, estado: 'agendada', fecha: { gte: hoy } }, data: { anulada: true } })).count;
    await tx.paciente.update({ where: { id: pacienteId }, data: { bloqueado: true, bloqueadoEl: new Date(ultimo.fecha) } });
  }
  // Un bloqueo por supresión es permanente: solo se levanta el que se pidió como bloqueo.
  if (ultimo && ultimo.tipo === 'desbloqueo' && paciente.bloqueado && !(await tx.solicitudDerecho.findFirst({ where: { pacienteId, derecho: 'supresion', estado: 'resuelta' }, select: { id: true } }))) {
    cambios.desbloqueo = 1;
    await tx.paciente.update({ where: { id: pacienteId }, data: { bloqueado: false, bloqueadoEl: null } });
  }

  for (const revocacion of anotaciones.filter((a) => a.tipo === 'revocacion')) {
    const { count } = await tx.consentimiento.updateMany({
      where: { pacienteId, revocadoEl: null, otorgadoEl: { lte: new Date(revocacion.fecha) }, ...(revocacion.finalidad ? { finalidad: { clave: revocacion.finalidad } } : {}) },
      data: { revocadoEl: new Date(revocacion.fecha), revocacionCanal: revocacion.canal || null },
    });
    cambios.consentimientos += count;
  }
  if (Object.values(cambios).every((n) => n === 0)) return false;

  await registrar({ actor: 'sistema', accion: 'REAPLICAR_RESTRICCION', entidad: 'Paciente', entidadId: pacienteId, detalle: cambios }, tx);
  return true;
}

/**
 * Vuelve a aplicar todo lo anotado: las supresiones (contacto en NULL,
 * consentimientos revocados, sin representante, bloqueado y sin citas
 * futuras) y, para quien no ejerció la supresión, el último bloqueo o
 * desbloqueo y las revocaciones de consentimiento. Es idempotente: solo toca
 * (y audita) a quien algo le volvió.
 *
 * @returns {Promise<{reaplicadas: number}>} pacientes que hubo que corregir.
 *
 * Consumidores: src/supresiones.js (npm run supresiones:reaplicar), que
 *   ejecuta ops/restaurar-db.sh después de restaurar.
 */
async function reaplicar() {
  const anotaciones = leerAnotaciones();
  const ids = [...new Set(anotaciones.map((a) => a.pacienteId))];
  let reaplicadas = 0;

  for (const pacienteId of ids) {
    const delPaciente = anotaciones.filter((a) => a.pacienteId === pacienteId);
    const suprimido = delPaciente.some((a) => a.tipo === 'supresion');
    const corregido = await prisma.$transaction((tx) => (suprimido ? reaplicarSupresion(pacienteId, tx) : reaplicarRestricciones(pacienteId, delPaciente, tx)));
    if (corregido) reaplicadas += 1;
  }
  return { reaplicadas };
}

module.exports = { registrarSupresion, reaplicar };
