const { prisma } = require('../lib/prisma');

// Plazos de conservación del inventario del Hito 1 que vencen antes que el
// registro clínico. Los que fija la ley no se tocan aquí: pacientes, citas y
// auditoría se conservan al menos 15 años (Ley 20.584, art. 13), y las
// sesiones vencen solas a las 8 horas (connect-pg-simple las elimina).
const MESES_NOTIFICACION = 12;
const MESES_CONTACTO_SIN_CITAS = 24;

function mesesAntes(fecha, meses) {
  const limite = new Date(fecha);
  limite.setMonth(limite.getMonth() - meses);
  return limite;
}

/**
 * Aplica los plazos de conservación que vencen antes que el registro
 * clínico:
 *   - Notificaciones: se eliminan al cumplir un año. Solo avisan al médico de
 *     cambios en su agenda; pasado ese tiempo no tienen finalidad.
 *   - Contacto del paciente: se elimina (queda en NULL) cuando lleva dos años
 *     sin citas, ni pasadas ni futuras, en ese período. Solo sirve para
 *     avisarle de cambios en sus citas. El resto de la ficha se conserva.
 *
 * Es idempotente: correrlo de nuevo no cambia nada hasta que venza otro
 * plazo. No registra auditoría, porque la tabla exige un usuario y lo corre
 * el sistema; el resumen queda en el log de quien lo ejecuta.
 *
 * @param {Date} [ahora] - fecha de referencia; por omisión, ahora.
 * @returns {Promise<{notificacionesEliminadas: number, contactosEliminados: number}>}
 *
 * Consumidores: src/retencion.js (npm run retencion).
 */
async function aplicarRetencion(ahora = new Date()) {
  const { count: notificacionesEliminadas } = await prisma.notificacion.deleteMany({
    where: { createdAt: { lt: mesesAntes(ahora, MESES_NOTIFICACION) } },
  });

  const limiteContacto = mesesAntes(ahora, MESES_CONTACTO_SIN_CITAS);
  const { count: contactosEliminados } = await prisma.paciente.updateMany({
    where: {
      contactoCifrado: { not: null },
      createdAt: { lt: limiteContacto },
      citas: { none: { fecha: { gte: limiteContacto } } },
    },
    data: { contactoCifrado: null },
  });

  return { notificacionesEliminadas, contactosEliminados };
}

module.exports = { aplicarRetencion };
