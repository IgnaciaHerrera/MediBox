const { prisma } = require('../lib/prisma');
const { ipActual } = require('../lib/contexto');
const { indiceCiego } = require('../lib/cifrado');

// Lo que sale de la auditoría hacia la API, la pantalla y el CSV. De quien
// actuó basta su nombre: la fila completa del usuario incluye el hash de su
// contraseña y su correo. El HMAC del correo (emailIndice) es solo para las
// reglas de monitoreo y no sale.
const SELECT_REGISTRO = {
  id: true,
  usuarioId: true,
  actor: true,
  accion: true,
  entidad: true,
  entidadId: true,
  resultado: true,
  ip: true,
  detalle: true,
  timestamp: true,
  usuario: { select: { id: true, nombre: true } },
};

/**
 * Escribe una fila de auditoría. Registra quién, qué, sobre qué registro,
 * desde dónde y con qué resultado; nunca el contenido de los datos. La IP la
 * toma del contexto de la petición (lib/contexto.js): los procesos del
 * sistema no tienen IP.
 *
 * @param {object} evento
 * @param {(number|null)} [evento.usuarioId] - quien actuó; null para el
 *   sistema o para un login fallido con un correo que no existe.
 * @param {string} evento.accion - p. ej. 'READ', 'LOGIN_FALLIDO', 'RETENCION'.
 * @param {string} evento.entidad - p. ej. 'Paciente', 'Usuario', 'Sistema'.
 * @param {number} evento.entidadId - id del registro; 0 para listas o el sistema.
 * @param {('usuario'|'sistema')} [evento.actor='usuario']
 * @param {('exito'|'denegado'|'fallido')} [evento.resultado='exito']
 * @param {(Buffer|null)} [evento.emailIndice] - indiceEmail() de un login fallido.
 * @param {object} [evento.detalle] - conteos o ids internos, sin datos personales.
 * @param {object} [client] - prisma o la transacción en curso.
 * @returns {Promise<void>}
 *
 * Consumidores: todos los servicios que leen o modifican datos personales,
 *   authController, routes/auth.js, middleware/requirePermission.js.
 */
async function registrar(
  { usuarioId = null, accion, entidad, entidadId, actor = 'usuario', resultado = 'exito', emailIndice = null, detalle },
  client = prisma,
) {
  await client.auditLog.create({
    data: { usuarioId, accion, entidad, entidadId, actor, resultado, ip: ipActual(), emailIndice, detalle },
  });
}

/**
 * HMAC del correo normalizado, para auditar un login fallido sin guardar el
 * correo: permite contar los intentos sobre una misma cuenta.
 *
 * @param {string} email
 * @returns {Buffer} 32 bytes.
 *
 * Consumidores: authController.login, routes/auth.js (límite de intentos),
 *   alertasService, tests.
 */
function indiceEmail(email) {
  return indiceCiego('auditoria.email', String(email).trim().toLowerCase());
}

function construirWhere({ accion, entidad, usuarioId, desde, hasta } = {}) {
  const timestamp = {};
  if (desde) timestamp.gte = new Date(`${desde}T00:00:00.000Z`);
  if (hasta) timestamp.lte = new Date(`${hasta}T23:59:59.999Z`);

  return {
    ...(accion ? { accion } : {}),
    ...(entidad ? { entidad } : {}),
    ...(usuarioId ? { usuarioId: Number(usuarioId) } : {}),
    ...(Object.keys(timestamp).length > 0 ? { timestamp } : {}),
  };
}

async function listar({ page = 1, pageSize = 20, accion, entidad, usuarioId, desde, hasta } = {}) {
  const where = construirWhere({ accion, entidad, usuarioId, desde, hasta });
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: SELECT_REGISTRO,
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

// Filtros opcionales para la exportación: desde/hasta (AAAA-MM-DD) y acción,
// con el mismo criterio que la pantalla de auditoría. Sin filtros, todo.
async function listarTodo(usuarioId, { accion, desde, hasta } = {}) {
  const items = await prisma.auditLog.findMany({
    where: construirWhere({ accion, desde, hasta }),
    orderBy: { timestamp: 'desc' },
    select: SELECT_REGISTRO,
  });
  await registrar({ usuarioId, accion: 'EXPORT', entidad: 'AuditLog', entidadId: 0 });
  return items;
}

async function obtenerUltimoRegistro({ accion, entidad }) {
  return prisma.auditLog.findFirst({
    where: { accion, entidad },
    orderBy: { timestamp: 'desc' },
    select: SELECT_REGISTRO,
  });
}

async function listarPorEntidad(entidad, entidadId) {
  return prisma.auditLog.findMany({
    where: { entidad, entidadId },
    orderBy: { timestamp: 'asc' },
    select: SELECT_REGISTRO,
  });
}

// Opciones reales presentes en la tabla, no una lista hardcodeada que se
// desactualizaría en cuanto un servicio nuevo empiece a auditar algo distinto.
async function listarAccionesDistintas() {
  const filas = await prisma.auditLog.findMany({ distinct: ['accion'], select: { accion: true }, orderBy: { accion: 'asc' } });
  return filas.map((f) => f.accion);
}

async function listarEntidadesDistintas() {
  const filas = await prisma.auditLog.findMany({ distinct: ['entidad'], select: { entidad: true }, orderBy: { entidad: 'asc' } });
  return filas.map((f) => f.entidad);
}

// La auditoría se conserva lo mismo que el registro del paciente (Ley 20.584,
// art. 13): así un paciente puede reclamar por un acceso indebido mientras
// exista su ficha. El trigger de la base rechaza borrar una fila más nueva.
const ANIOS_CONSERVACION = 15;

/**
 * Elimina las filas de auditoría que ya cumplieron los 15 años y deja
 * constancia de cuántas. Solo funciona con el dueño de la base (la
 * aplicación no tiene DELETE sobre audit_log) y solo sobre filas vencidas
 * (el trigger rechaza el resto). Después conviene un VACUUM para que
 * PostgreSQL reutilice el espacio de las filas borradas.
 *
 * @param {Date} [ahora]
 * @returns {Promise<{eliminadas: number, anteriorA: Date}>}
 *
 * Consumidores: src/auditoria-purgar.js (npm run auditoria:purgar).
 */
async function purgarVencidos(ahora = new Date()) {
  const anteriorA = new Date(ahora);
  anteriorA.setFullYear(anteriorA.getFullYear() - ANIOS_CONSERVACION);
  const eliminadas = await prisma.$executeRaw`DELETE FROM "audit_log" WHERE "timestamp" < ${anteriorA}`;
  await registrar({ actor: 'sistema', accion: 'PURGAR_AUDITORIA', entidad: 'Sistema', entidadId: 0, detalle: { eliminadas, anteriorA: anteriorA.toISOString() } });
  return { eliminadas, anteriorA };
}

module.exports = {
  ANIOS_CONSERVACION,
  purgarVencidos,
  registrar,
  indiceEmail,
  listar,
  listarTodo,
  obtenerUltimoRegistro,
  listarPorEntidad,
  listarAccionesDistintas,
  listarEntidadesDistintas,
};
