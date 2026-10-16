const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');

// Sesiones del personal (tabla "session" de connect-pg-simple). Cerrar las de
// una sola cuenta es la contención de una cuenta comprometida sin cerrar la
// sesión de todo el hospital (lección del simulacro del Hito 3).

async function tablaExiste() {
  const [{ existe }] = await prisma.$queryRaw`SELECT to_regclass('public.session') IS NOT NULL AS existe`;
  return existe;
}

/**
 * Cierra todas las sesiones abiertas de una cuenta, salvo opcionalmente la
 * de quien hace el cambio.
 *
 * @param {number} usuarioId - la cuenta.
 * @param {{excepto?: string, actor?: ('usuario'|'sistema'), solicitanteId?: number}} [opciones]
 *   excepto: id de sesión que se conserva (la propia, al cambiar la propia
 *   contraseña).
 * @returns {Promise<number>} cuántas sesiones se cerraron.
 *
 * Consumidores: usuarioService.cambiarPassword, src/sesiones.js
 *   (npm run sesiones:cerrar).
 */
async function cerrarSesionesDe(usuarioId, { excepto = '', actor = 'usuario', solicitanteId = null } = {}) {
  if (!(await tablaExiste())) return 0;
  const cerradas = await prisma.$executeRaw`DELETE FROM "session" WHERE sess->>'usuarioId' = ${String(usuarioId)} AND sid <> ${excepto}`;
  await registrar({ actor, usuarioId: solicitanteId, accion: 'CERRAR_SESIONES', entidad: 'Usuario', entidadId: usuarioId, detalle: { cerradas } });
  return cerradas;
}

module.exports = { cerrarSesionesDe };
