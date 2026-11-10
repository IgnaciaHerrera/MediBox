const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { registrar } = require('./auditService');
const { anotarRestriccion } = require('./anotacionService');

// Depuración de lo bloqueado al cumplirse el plazo legal (Hito 3).
//
// La Ley 20.584, art. 13, obliga a conservar la ficha clínica al menos 15
// años. Eso es lo que la supresión y el bloqueo dejan bloqueado: se conserva,
// pero no se usa. Pasado el plazo ya no hay obligación que lo justifique, y lo
// que se conserva sin finalidad se elimina. El plazo cuenta desde la última
// atención (la última cita que no se anuló) o, si el paciente nunca tuvo una,
// desde su alta.
//
// Solo se depura lo que está bloqueado: el titular lo pidió y se le prometió
// que era temporal. Un paciente sin bloquear que cumplió el plazo no se toca
// aquí; eliminarlo corresponde a un procedimiento del hospital.
//
// La aplicación no puede borrar pacientes (rol medibox_app, migración
// 20261023120000_rol_aplicacion): la corre el dueño de la base, y la autoriza
// una cuenta con el permiso derechos.gestionar. Los respaldos rotan a los 30
// días; entretanto cada depuración se anota para reaplicarla al restaurar
// (anotacionService, supresionService.reaplicar).

const ANIOS_FICHA = 15;

const aDia = (fecha) => fecha.toISOString().slice(0, 10);

function haceAnios(fecha, anios) {
  const limite = new Date(fecha);
  limite.setFullYear(limite.getFullYear() - anios);
  return limite;
}

/**
 * Pacientes bloqueados cuya última atención cumplió el plazo de conservación,
 * sin una solicitud de derechos abierta (esa se resuelve primero). No muestra
 * datos personales: solo el id, cuándo fue la última atención y por qué está
 * bloqueado.
 *
 * @param {Date} [ahora]
 * @param {{soloIds?: number[]}} [opciones] - limita la búsqueda a esos pacientes.
 * @returns {Promise<Array<{pacienteId: number, ultimaAtencion: string,
 *   origen: ('supresion'|'bloqueo'|null)}>>} ordenados por id; la fecha es AAAA-MM-DD.
 *
 * Consumidores: depurar(), src/depuracion.js.
 */
async function candidatos(ahora = new Date(), { soloIds } = {}) {
  const limite = aDia(haceAnios(ahora, ANIOS_FICHA));
  const bloqueados = await prisma.paciente.findMany({
    where: { bloqueado: true, ...(soloIds ? { id: { in: soloIds } } : {}), solicitudes: { none: { estado: { in: ['recibida', 'verificada'] } } } },
    select: { id: true, createdAt: true },
  });
  if (bloqueados.length === 0) return [];

  const ids = bloqueados.map((p) => p.id);
  const ultimas = await prisma.cita.groupBy({ by: ['pacienteId'], where: { pacienteId: { in: ids }, anulada: false }, _max: { fecha: true } });
  const ultimaCita = new Map(ultimas.map((u) => [u.pacienteId, u._max.fecha]));
  const origenes = await prisma.solicitudDerecho.findMany({
    where: { pacienteId: { in: ids }, estado: 'resuelta', derecho: { in: ['supresion', 'bloqueo'] } },
    select: { pacienteId: true, derecho: true },
  });
  const origenDe = (id) => {
    const derechos = origenes.filter((o) => o.pacienteId === id).map((o) => o.derecho);
    return derechos.includes('supresion') ? 'supresion' : derechos.includes('bloqueo') ? 'bloqueo' : null;
  };

  return bloqueados
    .map((p) => ({ pacienteId: p.id, ultimaAtencion: aDia(ultimaCita.get(p.id) || p.createdAt), origen: origenDe(p.id) }))
    .filter((c) => c.ultimaAtencion < limite)
    .sort((a, b) => a.pacienteId - b.pacienteId);
}

/**
 * Elimina un paciente y todo lo que lo referencia, en el orden que exigen las
 * claves foráneas. La auditoría no se toca: solo guarda ids y es la prueba de
 * lo ocurrido.
 *
 * @param {object} tx - la transacción en curso (con el dueño de la base).
 * @param {number} pacienteId
 * @returns {Promise<(object|null)>} cuántas filas eliminó de cada tabla, o null
 *   si el paciente no existe.
 *
 * Consumidores: depurar(), supresionService.reaplicar (depuración).
 */
async function eliminarPaciente(tx, pacienteId) {
  if (!(await tx.paciente.findUnique({ where: { id: pacienteId }, select: { id: true } }))) return null;
  const where = { pacienteId };
  const historial = (await tx.historialCambio.deleteMany({ where })).count;
  const consentimientos = (await tx.consentimiento.deleteMany({ where })).count;
  const solicitudes = (await tx.solicitudDerecho.deleteMany({ where })).count;
  const verificaciones = (await tx.verificacionIdentidad.deleteMany({ where })).count;
  const citas = (await tx.cita.deleteMany({ where })).count;
  await tx.paciente.delete({ where: { id: pacienteId } });
  return { citas, consentimientos, solicitudes, historial, verificaciones };
}

// Quien autoriza responde por la eliminación: una cuenta activa del rol que
// resuelve los derechos de los titulares.
async function exigirAutorizacion(usuarioId) {
  const usuario = usuarioId
    ? await prisma.usuario.findFirst({
        where: { id: usuarioId, suspendida: false, rol: { permisos: { some: { permiso: { clave: 'derechos.gestionar' } } } } },
        select: { id: true },
      })
    : null;
  if (!usuario) throw new AppError('Quien autoriza la depuración debe ser una cuenta activa con el permiso derechos.gestionar (rol privacidad)', 403);
}

/**
 * Elimina de verdad a los pacientes bloqueados que cumplieron el plazo legal,
 * con todos sus datos. Cada uno queda en una transacción propia, en la
 * auditoría (DEPURAR_PACIENTE, con quien lo autorizó) y anotado fuera de la
 * base para reaplicarlo si se restaura un respaldo anterior.
 *
 * @param {object} opciones
 * @param {Date} [opciones.ahora]
 * @param {number} opciones.autorizadoPorId - cuenta con derechos.gestionar.
 * @param {number[]} [opciones.soloIds] - limita la depuración a esos pacientes.
 * @returns {Promise<{eliminados: number, anteriorA: string, pacientes: object[]}>}
 * @throws {AppError} 403 si quien autoriza no existe, está suspendido o no
 *   tiene el permiso.
 *
 * Consumidores: src/depuracion.js (npm run depuracion).
 */
async function depurar({ ahora = new Date(), autorizadoPorId, soloIds } = {}) {
  await exigirAutorizacion(autorizadoPorId);
  const pacientes = [];
  for (const candidato of await candidatos(ahora, { soloIds })) {
    const eliminado = await prisma.$transaction(async (tx) => {
      const detalle = await eliminarPaciente(tx, candidato.pacienteId);
      if (!detalle) return null;
      await registrar(
        { usuarioId: autorizadoPorId, actor: 'sistema', accion: 'DEPURAR_PACIENTE', entidad: 'Paciente', entidadId: candidato.pacienteId, detalle: { ...detalle, origen: candidato.origen || 'sin_solicitud' } },
        tx,
      );
      return detalle;
    });
    if (eliminado) {
      // Ya confirmada: se anota para reaplicarla si se restaura un respaldo anterior.
      await anotarRestriccion({ tipo: 'depuracion', pacienteId: candidato.pacienteId });
      pacientes.push({ pacienteId: candidato.pacienteId, ...eliminado });
    }
  }
  return { eliminados: pacientes.length, anteriorA: aDia(haceAnios(ahora, ANIOS_FICHA)), pacientes };
}

module.exports = { ANIOS_FICHA, candidatos, depurar, eliminarPaciente };
