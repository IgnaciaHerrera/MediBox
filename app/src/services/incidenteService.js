const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Joi = require('joi');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const pacienteService = require('./pacienteService');
const { registrar } = require('./auditService');
const { isoLocal, fechaDMA } = require('../lib/fecha');
const { EVENTOS, esSensible } = require('../lib/eventosAuditoria');
const alertasService = require('./alertasService');

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
 * @param {{desde: Date, hasta: Date, usuarioId?: number, conIds?: boolean, incidenteId?: number}} opciones
 *   incidenteId: el incidente que se investiga (queda en su bitácora).
 * @returns {Promise<{desde: Date, hasta: Date, usuarioId: ?number, titulares: number,
 *   porCategoria: {identidad: number, contacto: number, salud: number}, menores: number, menores14: number,
 *   acciones: object, listados: number, exportacionesSeudonimizadas: number, ids?: number[]}>}
 *   Sin datos personales: los ids de los titulares solo si se piden (para
 *   notificarlos).
 * @throws {AppError} 400 si la ventana es inválida.
 *
 * Consumidores: src/incidente.js (npm run incidente:alcance).
 */
async function estimarAlcance({ desde, hasta, usuarioId, conIds = false, incidenteId = null }) {
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

  await registrar({
    actor: 'sistema',
    accion: 'ESTIMAR_ALCANCE',
    entidad: 'Sistema',
    entidadId: 0,
    detalle: { titulares: categoriasPorTitular.size, menores14, conIds, ...(usuarioId ? { usuarioId } : {}), ...(incidenteId ? { incidenteId } : {}) },
  });
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
 * @param {{desde: Date, hasta: Date, usuarioId?: number, incidenteId?: number}} ventana
 *   incidenteId: el incidente que se investiga (queda en su bitácora).
 * @returns {Promise<{archivo: string, filas: number, sesiones: number, sha256: string}>}
 * @throws {AppError} 400 si la ventana es inválida.
 *
 * Consumidores: src/evidencia.js (npm run incidente:evidencia).
 */
async function preservarEvidencia({ desde, hasta, usuarioId, incidenteId = null }) {
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
  await registrar({ actor: 'sistema', accion: 'PRESERVAR_EVIDENCIA', entidad: 'Sistema', entidadId: 0, detalle: { ...resumen, ...(incidenteId ? { incidenteId } : {}) } });
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
  cuentaInvolucradaId: Joi.number().integer().positive().allow(null).empty(''),
}).messages({ 'string.min': 'El campo {#label} es demasiado corto', 'any.required': 'Falta {#label}' });

async function validarIncidente(datos) {
  const { error, value } = incidenteSchema.validate(datos || {}, { stripUnknown: true });
  if (error) throw new AppError(error.details[0].message, 400);
  if (value.ocurridoDesde && value.ocurridoHasta && value.ocurridoHasta < value.ocurridoDesde) throw new AppError('El período del incidente termina antes de empezar', 400);
  if (value.cuentaInvolucradaId && !(await prisma.usuario.findUnique({ where: { id: value.cuentaInvolucradaId }, select: { id: true } }))) {
    throw new AppError('La cuenta involucrada no existe', 400);
  }
  return value;
}

/**
 * Criterio del plan de respuesta para la gravedad de un incidente, a partir
 * de lo que se sabe de él. Es una sugerencia: la decide quien coordina.
 *   - crítica: datos de salud o de menores de 100 o más titulares, o
 *     credenciales o llaves comprometidas (exponen todo lo que protegen);
 *   - alta: datos de salud o de menores, aunque sean pocos titulares, o 100
 *     o más titulares de cualquier dato;
 *   - media: datos de identificación o contacto de menos de 100 titulares,
 *     o una falla de integridad o disponibilidad sin datos sensibles;
 *   - baja: sin titulares ni categorías afectadas conocidas.
 *
 * @param {{categoriasDatos: string[], titularesAfectados: ?number, incluyeMenores: boolean, dimension: string}} incidente
 * @returns {{severidad: string, motivo: string}}
 *
 * Consumidores: obtener(), vista de detalle de un incidente.
 */
function sugerirSeveridad(incidente) {
  const categorias = incidente.categoriasDatos || [];
  const titulares = incidente.titularesAfectados || 0;
  const sensibles = categorias.includes('salud') || categorias.includes('menores') || incidente.incluyeMenores;
  if (categorias.includes('credenciales') && incidente.dimension === 'confidencialidad') return { severidad: 'critica', motivo: 'credenciales o llaves comprometidas' };
  if (sensibles && titulares >= 100) return { severidad: 'critica', motivo: 'datos de salud o de menores de 100 o más titulares' };
  if (sensibles) return { severidad: 'alta', motivo: 'datos de salud o de menores' };
  if (titulares >= 100) return { severidad: 'alta', motivo: '100 o más titulares afectados' };
  if (titulares > 0 || categorias.length > 0 || incidente.dimension !== 'confidencialidad') return { severidad: 'media', motivo: 'datos no sensibles o falla de integridad o disponibilidad' };
  return { severidad: 'baja', motivo: 'sin titulares ni datos afectados conocidos' };
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
 * Registra un incidente nuevo, en estado 'alerta'. Con `alertaId`, escala
 * esa alerta: queda revisada y enlazada al incidente, en la misma
 * transacción (o las dos cosas, o ninguna).
 *
 * @param {object} datos - ver incidenteSchema; sin datos de pacientes.
 *   datos.alertaId (opcional): la alerta pendiente que se escala.
 * @param {{id: number}} solicitante - req.usuario (incidentes.gestionar).
 * @returns {Promise<{id: number}>}
 * @throws {AppError} 400 si faltan datos o son inválidos; 403, 404 o 409 si
 *   la alerta no se puede escalar (ver alertasService.alertaParaRevisar).
 *
 * Consumidores: incidenteViewController.crear.
 */
async function registrarIncidente(datos, solicitante) {
  const value = await validarIncidente(datos);
  const alertaId = datos && datos.alertaId ? Number(datos.alertaId) : null;
  if (alertaId !== null && !Number.isInteger(alertaId)) throw new AppError('Alerta inválida', 400);
  return prisma.$transaction(async (tx) => {
    if (alertaId) await alertasService.alertaParaRevisar(alertaId, solicitante, tx);
    const fila = await tx.incidente.create({ data: { ...value, estado: 'alerta', registradoPorId: solicitante.id }, select: { id: true } });
    await registrar(
      { usuarioId: solicitante.id, accion: 'REGISTRAR_INCIDENTE', entidad: 'Incidente', entidadId: fila.id, detalle: { severidad: value.severidad, dimension: value.dimension, ...(alertaId ? { alertaId } : {}) } },
      tx,
    );
    if (alertaId) {
      // Condicional: dos escalamientos simultáneos no crean dos incidentes para la misma alerta.
      const { count } = await tx.alerta.updateMany({
        where: { id: alertaId, estado: 'pendiente' },
        data: { estado: 'escalada', incidenteId: fila.id, revisadaPorId: solicitante.id, revisadaEl: new Date() },
      });
      if (count !== 1) throw new AppError('La alerta ya se revisó', 409);
      await registrar({ usuarioId: solicitante.id, accion: 'REVISAR_ALERTA', entidad: 'Alerta', entidadId: alertaId, detalle: { resultado: 'escalada', incidenteId: fila.id } }, tx);
    }
    return fila;
  });
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
  const value = await validarIncidente(datos);
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
    abierto: TRANSICIONES[incidente.estado].length > 0,
    exigeNotificarTitulares: exigeNotificarTitulares(incidente),
    severidadSugerida: sugerirSeveridad(incidente),
    alertaCsirtVence: new Date(incidente.detectadoEl.getTime() + HORAS_ALERTA_CSIRT * 60 * 60 * 1000),
    borrador: borradorNotificacion(incidente),
    alertas: await prisma.alerta.findMany({ where: { incidenteId: id }, select: { id: true, regla: true, severidad: true } }),
  };
}

// --- Bitácora del equipo de respuesta --------------------------------------

const FASES = ['deteccion', 'contencion', 'erradicacion', 'recuperacion', 'notificacion', 'lecciones'];
const accionSchema = Joi.object({
  fase: Joi.string().valid(...FASES).required(),
  descripcion: Joi.string().trim().min(5).max(2000).required(),
  realizadaEl: Joi.date().iso().max('now').required(),
}).messages({ 'date.max': 'La acción no puede ser futura', 'any.required': 'Falta {#label}' });

/**
 * Anota en la bitácora una acción del equipo de respuesta, con su fase y la
 * hora en que se hizo (la de registro la pone la base). Sirve para lo que no
 * pasa por MediBox: aislar un servidor, llamar a la Agencia, revisar el
 * firewall. La bitácora es de solo inserción.
 *
 * @param {number} id - el incidente; debe estar abierto.
 * @param {{fase: string, descripcion: string, realizadaEl: string}} datos
 * @param {{id: number}} solicitante - req.usuario (incidentes.gestionar).
 * @returns {Promise<{id: number}>}
 * @throws {AppError} 400 si son inválidos; 404 si no existe; 409 si está cerrado.
 *
 * Consumidores: incidenteViewController.anotar.
 */
async function registrarAccion(id, datos, solicitante) {
  const { error, value } = accionSchema.validate(datos || {}, { stripUnknown: true });
  if (error) throw new AppError(error.details[0].message, 400);
  const incidente = await incidenteOError(id);
  if (TRANSICIONES[incidente.estado].length === 0) throw new AppError('El incidente está cerrado: su bitácora ya no cambia', 409);
  return prisma.$transaction(async (tx) => {
    const fila = await tx.incidenteAccion.create({ data: { incidenteId: id, ...value, registradaPorId: solicitante.id }, select: { id: true } });
    await registrar({ usuarioId: solicitante.id, accion: 'ACCION_INCIDENTE', entidad: 'Incidente', entidadId: id, detalle: { fase: value.fase, accionId: fila.id } }, tx);
    return fila;
  });
}

const descripcionEvento = (accion) => (EVENTOS[accion] ? EVENTOS[accion].descripcion : accion);

function resumenDetalle(fila) {
  const d = fila.detalle || {};
  if (fila.accion === 'CAMBIAR_ESTADO_INCIDENTE') return `de ${d.de} a ${d.a}`;
  if (fila.accion === 'CERRAR_SESIONES') return `${d.cerradas} sesiones cerradas`;
  if (fila.accion === 'PRESERVAR_EVIDENCIA') return `${d.archivo}, ${d.filas} filas, SHA-256 ${String(d.sha256).slice(0, 16)}…`;
  if (fila.accion === 'ESTIMAR_ALCANCE') return `${d.titulares} titulares`;
  return null;
}

/**
 * La bitácora de un incidente, en orden: lo que anotó el equipo y lo que
 * hizo dentro de MediBox (registro, cambios de estado, alerta escalada,
 * evidencia, alcance, sesiones cerradas y cuentas suspendidas con
 * --incidente). Cada entrada con su hora y su responsable.
 *
 * @param {number} id
 * @returns {Promise<Array<{el: Date, fase: ?string, descripcion: string, quien: string, origen: ('equipo'|'sistema')}>>}
 *
 * Consumidores: incidenteViewController.detalle, tests del simulacro.
 */
async function bitacora(id) {
  const [acciones, eventos] = await Promise.all([
    prisma.incidenteAccion.findMany({ where: { incidenteId: id }, include: { registradaPor: { select: { nombre: true } } } }),
    prisma.auditLog.findMany({
      where: {
        OR: [{ entidad: 'Incidente', entidadId: id, accion: { not: 'ACCION_INCIDENTE' } }, { detalle: { path: ['incidenteId'], equals: id } }],
        accion: { not: 'RECONSTRUIR' },
      },
      include: { usuario: { select: { nombre: true } } },
    }),
  ]);
  return [
    ...acciones.map((a) => ({ el: a.realizadaEl, fase: a.fase, descripcion: a.descripcion, quien: a.registradaPor.nombre, origen: 'equipo', registradaEl: a.registradaEl })),
    ...eventos.map((e) => {
      const extra = resumenDetalle(e);
      return { el: e.timestamp, fase: null, descripcion: `${descripcionEvento(e.accion)}${extra ? ` (${extra})` : ''}`, quien: e.usuario ? e.usuario.nombre : 'Sistema', origen: 'sistema' };
    }),
  ].sort((a, b) => a.el - b.el);
}

// --- Reconstrucción de lo ocurrido -------------------------------------------

const EVENTOS_MAXIMOS = 2000;

/**
 * Reconstruye, desde la auditoría, lo que hizo una cuenta en un período: sus
 * acciones y los intentos contra ella (logins fallidos, cierres de sesión,
 * suspensión), en orden, con la IP y el resultado. Responde la pregunta del
 * plan: quién accedió a qué datos, cuándo y con qué resultado. La consulta
 * queda en la auditoría.
 *
 * @param {{desde: Date, hasta: Date, usuarioId: number, incidenteId?: number}} opciones
 * @param {{id: ?number}} [lector] - quien reconstruye; null para un proceso.
 * @returns {Promise<{eventos: Array<object>, resumen: object, truncado: boolean}>}
 *   resumen: total, porAccion, ips, pacientesDistintos, denegados, fallidos,
 *   sensibles, primera y ultima.
 * @throws {AppError} 400 si la ventana es inválida o supera 31 días, o falta la cuenta.
 *
 * Consumidores: obtener() vía incidenteViewController.detalle,
 *   src/reconstruir.js (npm run incidente:reconstruir), tests del simulacro.
 */
async function reconstruir({ desde, hasta, usuarioId, incidenteId = null }, lector = null) {
  if (!(desde instanceof Date) || !(hasta instanceof Date) || Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || hasta < desde) {
    throw new AppError('Ventana de fechas inválida', 400);
  }
  if (hasta - desde > alertasService.DIAS_MAXIMOS * 24 * 60 * 60 * 1000) throw new AppError(`La ventana no puede superar ${alertasService.DIAS_MAXIMOS} días`, 400);
  if (!Number.isInteger(usuarioId)) throw new AppError('Indica la cuenta involucrada', 400);

  const filas = await prisma.auditLog.findMany({
    where: { timestamp: { gte: desde, lte: hasta }, OR: [{ usuarioId }, { entidad: 'Usuario', entidadId: usuarioId }] },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    take: EVENTOS_MAXIMOS + 1,
    include: { usuario: { select: { nombre: true } } },
  });
  const truncado = filas.length > EVENTOS_MAXIMOS;
  const eventos = filas.slice(0, EVENTOS_MAXIMOS).map((f) => ({
    id: f.id,
    timestamp: f.timestamp,
    quien: f.usuario ? f.usuario.nombre : f.actor === 'sistema' ? 'Sistema' : 'Sin cuenta',
    accion: f.accion,
    descripcion: descripcionEvento(f.accion),
    entidad: f.entidad,
    entidadId: f.entidadId,
    resultado: f.resultado,
    ip: f.ip,
    sensible: esSensible(f.accion, f.entidad) && f.resultado === 'exito',
  }));

  const porAccion = {};
  eventos.forEach((e) => (porAccion[e.accion] = (porAccion[e.accion] || 0) + 1));
  const resumen = {
    total: eventos.length,
    porAccion,
    ips: [...new Set(eventos.map((e) => e.ip).filter(Boolean))],
    pacientesDistintos: new Set(eventos.filter((e) => e.sensible && e.entidad === 'Paciente' && e.entidadId !== 0).map((e) => e.entidadId)).size,
    denegados: eventos.filter((e) => e.resultado === 'denegado').length,
    fallidos: eventos.filter((e) => e.resultado === 'fallido').length,
    sensibles: eventos.filter((e) => e.sensible).length,
    primera: eventos.length ? eventos[0].timestamp : null,
    ultima: eventos.length ? eventos[eventos.length - 1].timestamp : null,
  };
  await registrar({
    actor: lector && lector.id ? 'usuario' : 'sistema',
    usuarioId: lector && lector.id ? lector.id : null,
    accion: 'RECONSTRUIR',
    entidad: incidenteId ? 'Incidente' : 'Sistema',
    entidadId: incidenteId || 0,
    detalle: { usuarioId, eventos: eventos.length, truncado },
  });
  return { eventos, resumen, truncado };
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
  FASES,
  sugerirSeveridad,
  registrarAccion,
  bitacora,
  reconstruir,
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
