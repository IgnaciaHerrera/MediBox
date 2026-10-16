const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const pacienteService = require('./pacienteService');
const { isoLocal } = require('../lib/fecha');

// Alcance de un incidente (plan de respuesta, Hito 3): a partir de la
// auditoría, cuántos titulares y qué categorías de datos tocaron los accesos
// de una ventana (y, si se indica, de un usuario). Es la base para llenar la
// notificación a la Agencia y a los titulares.
//
// Qué deja ver cada acción, según lo que muestra la aplicación:
//   - READ de la ficha: identidad, contacto y salud (las citas con su motivo).
//   - READ para verificar la identidad (detalle.motivo 'verificacion'): solo el contacto.
//   - EXPORT_TITULAR: todo.
//   - CREATE y UPDATE de un paciente: identidad y contacto.
//   - LIST: nombres y edades de una página de pacientes, sin saber cuáles
//     (se cuenta aparte).
//   - EXPORT de reportes: archivos seudonimizados (se cuentan aparte).
// Un acceso negado no expuso nada y no se cuenta.

const EDAD_ADULTA = 18;

function categoriasDe(fila) {
  if (fila.accion === 'READ') {
    return fila.detalle && fila.detalle.motivo === 'verificacion' ? ['contacto'] : ['identidad', 'contacto', 'salud'];
  }
  if (fila.accion === 'EXPORT_TITULAR') return ['identidad', 'contacto', 'salud'];
  if (fila.accion === 'CREATE' || fila.accion === 'UPDATE') return ['identidad', 'contacto'];
  return [];
}

/**
 * Estima el alcance de los accesos a datos de pacientes en una ventana.
 *
 * @param {{desde: Date, hasta: Date, usuarioId?: number, conIds?: boolean}} opciones
 * @returns {Promise<{desde: Date, hasta: Date, usuarioId: ?number, titulares: number,
 *   porCategoria: {identidad: number, contacto: number, salud: number}, menores: number,
 *   acciones: object, listados: number, exportacionesSeudonimizadas: number, ids?: number[]}>}
 *   Sin datos personales: los ids de los titulares solo si se piden (para
 *   notificarlos).
 * @throws {AppError} 400 si la ventana es inválida.
 *
 * Consumidores: src/incidente.js (npm run incidente:alcance).
 */
async function estimarAlcance({ desde, hasta, usuarioId, conIds = false }) {
  if (!(desde instanceof Date) || !(hasta instanceof Date) || Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || hasta < desde) {
    throw new AppError('Ventana de fechas inválida', 400);
  }

  const filas = await prisma.auditLog.findMany({
    where: {
      timestamp: { gte: desde, lte: hasta },
      resultado: 'exito',
      entidad: { in: ['Paciente', 'Investigacion', 'Cita', 'AuditLog'] },
      ...(usuarioId ? { usuarioId } : {}),
    },
    select: { accion: true, entidad: true, entidadId: true, detalle: true },
  });

  const acciones = {};
  const categoriasPorTitular = new Map();
  let listados = 0;
  let exportacionesSeudonimizadas = 0;
  for (const fila of filas) {
    acciones[fila.accion] = (acciones[fila.accion] || 0) + 1;
    if (fila.accion === 'LIST') listados += 1;
    if (fila.accion === 'EXPORT') exportacionesSeudonimizadas += 1;
    if (fila.entidad !== 'Paciente' || fila.entidadId === 0) continue;
    const categorias = categoriasDe(fila);
    if (categorias.length === 0) continue;
    if (!categoriasPorTitular.has(fila.entidadId)) categoriasPorTitular.set(fila.entidadId, new Set());
    categorias.forEach((c) => categoriasPorTitular.get(fila.entidadId).add(c));
  }

  const porCategoria = { identidad: 0, contacto: 0, salud: 0 };
  for (const categorias of categoriasPorTitular.values()) categorias.forEach((c) => (porCategoria[c] += 1));

  // Menor de edad a la fecha del incidente (el fin de la ventana), no a la de
  // hoy: quien era menor entonces se notifica como menor aunque ya no lo sea.
  const alISO = isoLocal(hasta).slice(0, 10);
  let menores = 0;
  for (const pacienteId of categoriasPorTitular.keys()) {
    try {
      if ((await pacienteService.edadDe(pacienteId, alISO)) < EDAD_ADULTA) menores += 1;
    } catch {
      // Un paciente que ya no está en la base (por ejemplo, de una base restaurada).
    }
  }

  return {
    desde,
    hasta,
    usuarioId: usuarioId || null,
    titulares: categoriasPorTitular.size,
    porCategoria,
    menores,
    acciones,
    listados,
    exportacionesSeudonimizadas,
    ...(conIds ? { ids: [...categoriasPorTitular.keys()] } : {}),
  };
}

module.exports = { estimarAlcance };
