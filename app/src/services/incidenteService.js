const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Joi = require('joi');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const pacienteService = require('./pacienteService');
const { registrar } = require('./auditService');
const { isoLocal, fechaDMA } = require('../lib/fecha');

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
// Ley 21.719, art. 14 sexies: si la vulneración toca datos de niños o niñas
// (menores de 14), también se comunica a los titulares.
const EDAD_NINO = 14;

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
 *   porCategoria: {identidad: number, contacto: number, salud: number}, menores: number, menores14: number,
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
  let menores14 = 0;
  for (const pacienteId of categoriasPorTitular.keys()) {
    try {
      const edad = await pacienteService.edadDe(pacienteId, alISO);
      if (edad < EDAD_ADULTA) menores += 1;
      if (edad < EDAD_NINO) menores14 += 1;
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
    menores14,
    acciones,
    listados,
    exportacionesSeudonimizadas,
    ...(conIds ? { ids: [...categoriasPorTitular.keys()] } : {}),
  };
}

// --- Preservación de evidencia ---------------------------------------------

function directorioEvidencias() {
  return process.env.EVIDENCIAS_DIR || path.join(__dirname, '..', '..', 'registro', 'evidencias');
}

/**
 * Copia la auditoría de una ventana (y de un usuario, si se indica) a un
 * archivo JSON Lines fuera de la base, antes de contener: cerrar sesiones,
 * suspender cuentas o restaurar un respaldo no debe destruir lo que sirve
 * para investigar. Lleva también qué sesiones tenía abiertas la cuenta (solo
 * el hash del identificador y el vencimiento). El SHA-256 del archivo queda
 * en la auditoría, que es de solo inserción: si alguien edita el archivo
 * después, el hash ya no coincide.
 *
 * @param {{desde: Date, hasta: Date, usuarioId?: number}} ventana
 * @returns {Promise<{archivo: string, filas: number, sesiones: number, sha256: string}>}
 * @throws {AppError} 400 si la ventana es inválida.
 *
 * Consumidores: src/evidencia.js (npm run incidente:evidencia).
 */
async function preservarEvidencia({ desde, hasta, usuarioId }) {
  if (!(desde instanceof Date) || !(hasta instanceof Date) || Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || hasta < desde) {
    throw new AppError('Ventana de fechas inválida', 400);
  }
  const filas = await prisma.auditLog.findMany({
    where: { timestamp: { gte: desde, lte: hasta }, ...(usuarioId ? { usuarioId } : {}) },
    orderBy: { id: 'asc' },
    select: { id: true, timestamp: true, usuarioId: true, actor: true, accion: true, entidad: true, entidadId: true, resultado: true, ip: true, emailIndice: true, detalle: true },
  });
  const sesiones = usuarioId
    ? await prisma.$queryRaw`SELECT sid, expire FROM "session" WHERE sess->>'usuarioId' = ${String(usuarioId)}`
    : [];

  const lineas = [
    { tipo: 'evidencia', generadaEl: new Date().toISOString(), desde: desde.toISOString(), hasta: hasta.toISOString(), usuarioId: usuarioId || null },
    ...filas.map((f) => ({ tipo: 'auditoria', ...f, emailIndice: f.emailIndice ? Buffer.from(f.emailIndice).toString('hex') : null })),
    // El identificador de sesión es una credencial: se guarda solo su hash.
    ...sesiones.map((x) => ({ tipo: 'sesion', sidSha256: crypto.createHash('sha256').update(x.sid).digest('hex'), expire: x.expire })),
  ];
  const contenido = `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
  const dir = directorioEvidencias();
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `evidencia-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  // wx: nunca sobrescribe una evidencia anterior; 0o440: solo lectura.
  fs.writeFileSync(archivo, contenido, { flag: 'wx', mode: 0o440 });

  const resumen = { archivo: path.basename(archivo), filas: filas.length, sesiones: sesiones.length, sha256 };
  await registrar({ actor: 'sistema', accion: 'PRESERVAR_EVIDENCIA', entidad: 'Sistema', entidadId: 0, detalle: resumen });
  return { ...resumen, archivo };
}

// --- Registro de incidentes (Ley 21.719, art. 14 sexies) --------------------

const ESTADOS = ['alerta', 'sospechoso', 'confirmado', 'descartado', 'cerrado'];
// Una alerta es una señal automática o un reporte sin analizar; un evento
// sospechoso, uno que el análisis no pudo descartar; un incidente
// confirmado, uno con evidencia de que se comprometió la confidencialidad,
// integridad o disponibilidad de datos personales.
const TRANSICIONES = {
  alerta: ['sospechoso', 'descartado'],
  sospechoso: ['confirmado', 'descartado'],
  confirmado: ['cerrado'],
  descartado: [],
  cerrado: [],
};
const ORIGENES = ['alerta_automatica', 'reporte_funcionario', 'reporte_titular', 'hallazgo_externo'];
const SEVERIDADES = ['baja', 'media', 'alta', 'critica'];
const DIMENSIONES = ['confidencialidad', 'integridad', 'disponibilidad'];
const CATEGORIAS = ['identidad', 'contacto', 'salud', 'menores', 'credenciales', 'trazabilidad'];
// Ley 21.663, art. 9: un incidente con efectos significativos en un servicio
// esencial (la prestación de salud lo es, art. 4) se alerta al CSIRT
// Nacional dentro de 3 horas desde que se conoce.
const HORAS_ALERTA_CSIRT = 3;

const fechaOpcional = Joi.date().iso().allow(null, '').empty('');
const textoOpcional = (max) => Joi.string().trim().max(max).allow(null, '').empty('');

const incidenteSchema = Joi.object({
  titulo: Joi.string().trim().min(5).max(150).required(),
  origen: Joi.string().valid(...ORIGENES).required(),
  severidad: Joi.string().valid(...SEVERIDADES).required(),
  dimension: Joi.string().valid(...DIMENSIONES).required(),
  descripcion: Joi.string().trim().min(10).max(4000).required(),
  ocurridoDesde: fechaOpcional,
  ocurridoHasta: fechaOpcional,
  categoriasDatos: Joi.array().items(Joi.string().valid(...CATEGORIAS)).single().default([]),
  titularesAfectados: Joi.number().integer().min(0).allow(null, '').empty(''),
  incluyeMenores: Joi.boolean().truthy('si').falsy('').default(false),
  consecuencias: textoOpcional(4000),
  medidas: textoOpcional(4000),
  recomendaciones: textoOpcional(4000),
  lecciones: textoOpcional(4000),
  sinNotificacionMotivo: textoOpcional(2000),
  notificadoAgenciaEl: fechaOpcional,
  notificadoTitularesEl: fechaOpcional,
  notificadoCsirtEl: fechaOpcional,
}).messages({ 'string.min': 'El campo {#label} es demasiado corto', 'any.required': 'Falta {#label}' });

function validarIncidente(datos) {
  const { error, value } = incidenteSchema.validate(datos || {}, { stripUnknown: true });
  if (error) throw new AppError(error.details[0].message, 400);
  if (value.ocurridoDesde && value.ocurridoHasta && value.ocurridoHasta < value.ocurridoDesde) throw new AppError('El período del incidente termina antes de empezar', 400);
  return value;
}

/**
 * Si un incidente confirmado obliga a comunicarlo a los titulares (Ley
 * 21.719, art. 14 sexies, inc. 3): datos sensibles (salud) o de niños o
 * niñas menores de 14.
 *
 * @param {{categoriasDatos: string[], incluyeMenores: boolean}} incidente
 * @returns {boolean}
 *
 * Consumidores: obtener(), borradorNotificacion().
 */
function exigeNotificarTitulares(incidente) {
  return incidente.categoriasDatos.includes('salud') || incidente.categoriasDatos.includes('menores') || incidente.incluyeMenores;
}

async function incidenteOError(id) {
  const fila = await prisma.incidente.findUnique({ where: { id } });
  if (!fila) throw new AppError('Incidente no encontrado', 404);
  return fila;
}

/**
 * Registra un incidente nuevo, en estado 'alerta'.
 *
 * @param {object} datos - ver incidenteSchema; sin datos de pacientes.
 * @param {{id: number}} solicitante - req.usuario (incidentes.gestionar).
 * @returns {Promise<{id: number}>}
 * @throws {AppError} 400 si faltan datos o son inválidos.
 *
 * Consumidores: incidenteViewController.crear.
 */
async function registrarIncidente(datos, solicitante) {
  const value = validarIncidente(datos);
  const fila = await prisma.incidente.create({ data: { ...value, estado: 'alerta', registradoPorId: solicitante.id }, select: { id: true } });
  await registrar({ usuarioId: solicitante.id, accion: 'REGISTRAR_INCIDENTE', entidad: 'Incidente', entidadId: fila.id, detalle: { severidad: value.severidad, dimension: value.dimension } });
  return fila;
}

/**
 * Actualiza lo que se sabe de un incidente abierto (alcance, medidas,
 * notificaciones). Uno cerrado o descartado ya no se edita.
 *
 * @param {number} id
 * @param {object} datos - ver incidenteSchema.
 * @param {{id: number}} solicitante
 * @returns {Promise<void>}
 * @throws {AppError} 400 si son inválidos; 409 si está cerrado o descartado.
 *
 * Consumidores: incidenteViewController.actualizar.
 */
async function actualizarIncidente(id, datos, solicitante) {
  const actual = await incidenteOError(id);
  if (TRANSICIONES[actual.estado].length === 0) throw new AppError('El incidente está cerrado: ya no se edita', 409);
  const value = validarIncidente(datos);
  await prisma.incidente.update({ where: { id }, data: value });
  await registrar({ usuarioId: solicitante.id, accion: 'ACTUALIZAR_INCIDENTE', entidad: 'Incidente', entidadId: id });
}

/**
 * Cambia el estado de un incidente siguiendo el ciclo alerta -> sospechoso
 * -> confirmado -> cerrado (o descartado). Cerrar exige las medidas, las
 * lecciones aprendidas y la decisión sobre la notificación: la fecha en que
 * se notificó a la Agencia, o el motivo para no hacerlo (sin riesgo
 * razonable para los titulares). Si había que comunicarlo a los titulares,
 * exige además esa fecha.
 *
 * @param {number} id
 * @param {string} estado - el nuevo.
 * @param {{id: number}} solicitante
 * @returns {Promise<void>}
 * @throws {AppError} 400 si el estado no existe; 409 si la transición no
 *   está permitida o falta algo para cerrar.
 *
 * Consumidores: incidenteViewController.cambiarEstado.
 */
async function cambiarEstado(id, estado, solicitante) {
  if (!ESTADOS.includes(estado)) throw new AppError('Estado desconocido', 400);
  const actual = await incidenteOError(id);
  if (!TRANSICIONES[actual.estado].includes(estado)) throw new AppError(`Un incidente ${actual.estado} no pasa a ${estado}`, 409);
  if (estado === 'cerrado') {
    if (!actual.medidas || !actual.lecciones) throw new AppError('Para cerrar, registra las medidas tomadas y las lecciones aprendidas', 409);
    if (!actual.notificadoAgenciaEl && !actual.sinNotificacionMotivo) throw new AppError('Para cerrar, registra cuándo se notificó a la Agencia o por qué no correspondía', 409);
    if (actual.notificadoAgenciaEl && exigeNotificarTitulares(actual) && !actual.notificadoTitularesEl) {
      throw new AppError('Afecta datos de salud o de menores de 14: registra cuándo se comunicó a los titulares', 409);
    }
  }
  const { count } = await prisma.incidente.updateMany({
    where: { id, estado: actual.estado },
    data: { estado, ...(estado === 'cerrado' || estado === 'descartado' ? { cerradoEl: new Date() } : {}) },
  });
  if (count !== 1) throw new AppError('El incidente cambió mientras tanto: vuelve a abrirlo', 409);
  await registrar({ usuarioId: solicitante.id, accion: 'CAMBIAR_ESTADO_INCIDENTE', entidad: 'Incidente', entidadId: id, detalle: { de: actual.estado, a: estado } });
}

/**
 * @returns {Promise<Array<object>>} los incidentes, abiertos primero.
 *
 * Consumidores: incidenteViewController.index.
 */
async function listarIncidentes() {
  const filas = await prisma.incidente.findMany({ orderBy: [{ cerradoEl: { sort: 'desc', nulls: 'first' } }, { detectadoEl: 'desc' }] });
  return filas.map((f) => ({ ...f, abierto: TRANSICIONES[f.estado].length > 0 }));
}

/**
 * Un incidente con lo que la vista necesita: estados a los que puede pasar,
 * si hay que comunicarlo a los titulares, el plazo de la alerta al CSIRT y
 * el borrador de la notificación.
 *
 * @param {number} id
 * @returns {Promise<object>}
 * @throws {AppError} 404 si no existe.
 *
 * Consumidores: incidenteViewController.detalle.
 */
async function obtener(id) {
  const incidente = await incidenteOError(id);
  return {
    ...incidente,
    siguientes: TRANSICIONES[incidente.estado],
    exigeNotificarTitulares: exigeNotificarTitulares(incidente),
    alertaCsirtVence: new Date(incidente.detectadoEl.getTime() + HORAS_ALERTA_CSIRT * 60 * 60 * 1000),
    borrador: borradorNotificacion(incidente),
  };
}

const NOMBRE_CATEGORIA = { identidad: 'identificación (nombre, RUT, fecha de nacimiento)', contacto: 'contacto', salud: 'salud (citas y motivo de consulta)', menores: 'datos de niños, niñas y adolescentes', credenciales: 'credenciales de acceso', trazabilidad: 'registros de acceso' };
const fechaTexto = (valor) => (valor ? fechaDMA(isoLocal(valor).slice(0, 16)) : 'por determinar');

/**
 * Borrador de la comunicación a la Agencia y a los titulares, con los
 * contenidos mínimos del plan (y del art. 14 sexies): qué ocurrió, cuándo se
 * detectó y en qué período, qué datos, qué consecuencias, qué medidas, qué
 * recomendaciones y un contacto. Lo revisa y autoriza el responsable de los
 * datos antes de enviarlo: el sistema no lo envía.
 *
 * @param {object} incidente - fila de incidentes.
 * @returns {string}
 *
 * Consumidores: obtener().
 */
function borradorNotificacion(incidente) {
  const categorias = incidente.categoriasDatos.length ? incidente.categoriasDatos.map((c) => NOMBRE_CATEGORIA[c]).join(', ') : 'por determinar';
  return [
    `Asunto: Vulneración de seguridad de datos personales en MediBox (incidente N° ${incidente.id})`,
    '',
    `1. Qué ocurrió: ${incidente.descripcion}`,
    `2. Cuándo: detectado el ${fechaTexto(incidente.detectadoEl)}; período en que ocurrió: ${incidente.ocurridoDesde ? `${fechaTexto(incidente.ocurridoDesde)} a ${fechaTexto(incidente.ocurridoHasta)}` : 'por determinar'}.`,
    `3. Datos afectados: ${categorias}. Titulares afectados (aproximado): ${incidente.titularesAfectados ?? 'por determinar'}${incidente.incluyeMenores ? ', entre ellos menores de edad' : ''}.`,
    `4. Posibles consecuencias para los titulares: ${incidente.consecuencias || 'por determinar'}`,
    `5. Medidas de contención y mitigación adoptadas: ${incidente.medidas || 'por determinar'}`,
    `6. Recomendaciones para reducir los riesgos: ${incidente.recomendaciones || 'por determinar'}`,
    '7. Contacto para consultas y seguimiento: encargado de protección de datos del hospital (admisión o el canal indicado en /privacidad).',
  ].join('\n');
}

module.exports = {
  estimarAlcance,
  preservarEvidencia,
  ESTADOS,
  ORIGENES,
  SEVERIDADES,
  DIMENSIONES,
  CATEGORIAS,
  exigeNotificarTitulares,
  registrarIncidente,
  actualizarIncidente,
  cambiarEstado,
  listarIncidentes,
  obtener,
  borradorNotificacion,
};
