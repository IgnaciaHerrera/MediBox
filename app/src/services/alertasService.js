const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { registrar } = require('./auditService');
const { crearNotificacion } = require('./notificacionService');
const { seudonimo } = require('./pacienteService');

// Monitoreo de accesos anómalos (Hito 3). Registrar no basta: alguien debe
// mirar. Cada regla es una consulta sobre audit_log con un umbral fijo. La
// salida nunca lleva datos de pacientes: solo la regla, quién, cuántas veces
// y cuándo; el detalle se revisa en la auditoría.

const ZONA_HORARIA = 'America/Santiago';
// Inicios de sesión fallidos sobre una misma cuenta (por usuario o por el
// HMAC del correo intentado), o códigos de verificación fallidos sobre un
// mismo paciente, dentro de la ventana.
const UMBRAL_FALLIDOS = 5;
const VENTANA_FALLIDOS_MIN = 15;
// Horario habitual de la atención: de 07:00 a 19:59, hora de Chile.
const HORARIO_INICIO = 7;
const HORARIO_FIN = 20;
// Más pacientes distintos leídos por un usuario en una misma hora, o más
// exportaciones en un mismo día, que lo que justifica una jornada normal.
const UMBRAL_LECTURAS_HORA = 30;
const UMBRAL_EXPORTACIONES_DIA = 3;
// Ventana máxima consultable: acota el costo de las consultas.
const DIAS_MAXIMOS = 31;
// "Ubicación inusual": un inicio de sesión desde una IP que la cuenta no usó
// en los 30 días anteriores (y que sí inició sesión en ese período: la
// primera vez de una cuenta nueva no es inusual).
const DIAS_HISTORIAL_IP = 30;

// Intentos negados sobre cuentas, roles o auditoría de una misma cuenta en
// un día: uno puede ser un clic equivocado; tres, alguien probando a qué más
// puede llegar.
const UMBRAL_DENEGADOS = 3;

// Cada regla dice qué la dispara, cuán grave es, qué rol la revisa y en
// cuántas horas. Privacidad revisa las que pueden ser una extracción de datos
// o un cambio de accesos (que el administrador no revise sus propios
// cambios); el gestor, el resto. Las críticas se revisan en el plazo de la
// alerta temprana al CSIRT (3 horas, Ley 21.663).
const REGLAS = {
  FALLIDOS: { nombre: 'Inicios de sesión fallidos', descripcion: `${UMBRAL_FALLIDOS} o más intentos fallidos sobre una misma cuenta en ${VENTANA_FALLIDOS_MIN} minutos.`, severidad: 'media', responsable: 'gestor', plazoHoras: 24 },
  CODIGOS_FALLIDOS: { nombre: 'Códigos de verificación fallidos', descripcion: `${UMBRAL_FALLIDOS} o más códigos incorrectos sobre un mismo paciente en ${VENTANA_FALLIDOS_MIN} minutos.`, severidad: 'alta', responsable: 'gestor', plazoHoras: 8 },
  FUERA_DE_HORARIO: { nombre: 'Fuera de horario', descripcion: `Accesos a datos de pacientes entre las ${HORARIO_FIN}:00 y las ${HORARIO_INICIO}:00.`, severidad: 'media', responsable: 'gestor', plazoHoras: 24 },
  VOLUMEN_LECTURAS: { nombre: 'Volumen de lecturas', descripcion: `Más de ${UMBRAL_LECTURAS_HORA} pacientes distintos leídos en una misma hora.`, severidad: 'alta', responsable: 'privacidad', plazoHoras: 4 },
  VOLUMEN_EXPORTACIONES: { nombre: 'Volumen de exportaciones', descripcion: `Más de ${UMBRAL_EXPORTACIONES_DIA} exportaciones en un mismo día.`, severidad: 'alta', responsable: 'privacidad', plazoHoras: 4 },
  FUERA_DE_FUNCION: { nombre: 'Acceso negado', descripcion: 'Intentos de ver datos de pacientes fuera de la función o el alcance del usuario.', severidad: 'media', responsable: 'gestor', plazoHoras: 24 },
  PRIVILEGIOS_NEGADOS: { nombre: 'Intentos de escalar privilegios', descripcion: `${UMBRAL_DENEGADOS} o más intentos en un día de usar funciones de cuentas, roles o auditoría sin el permiso.`, severidad: 'alta', responsable: 'privacidad', plazoHoras: 8 },
  CAMBIO_DE_ACCESO: { nombre: 'Cambio de accesos (informativa)', descripcion: 'Creación de cuentas y cambios de rol o de permisos: confirmar que respondan a un proceso autorizado.', severidad: 'baja', responsable: 'privacidad', plazoHoras: 72 },
  IP_NUEVA: { nombre: 'Ubicación inusual', descripcion: `Inicio de sesión desde una IP que la cuenta no usó en los ${DIAS_HISTORIAL_IP} días anteriores.`, severidad: 'baja', responsable: 'gestor', plazoHoras: 72 },
  PORTAL_ABUSO: { nombre: 'Abuso del portal del paciente', descripcion: 'Pedidos de código bloqueados por el límite por IP o por el tope de envíos a un mismo paciente.', severidad: 'media', responsable: 'gestor', plazoHoras: 24 },
  AUDITORIA_ALTERADA: { nombre: 'Auditoría alterada', descripcion: 'La auditoría de la base no coincide con su copia externa (npm run auditoria:verificar): filas eliminadas, alteradas o agregadas después.', severidad: 'critica', responsable: 'privacidad', plazoHoras: 3 },
};
const SEVERIDADES = ['critica', 'alta', 'media', 'baja'];

const ACCIONES = ['LOGIN_FALLIDO', 'VERIFICAR_IDENTIDAD', 'READ', 'LIST', 'EXPORT', 'EXPORT_TITULAR', 'UPDATE_PERMISOS', 'UPDATE_ROL', 'CREATE', 'LOGIN', 'PORTAL_LIMITADO', 'PORTAL_CODIGO', 'ACCESO_DENEGADO', 'VERIFICAR_AUDITORIA'];

const formatoHora = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA_HORARIA, hour: '2-digit', hourCycle: 'h23' });
const formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' });
const horaLocal = (fecha) => Number(formatoHora.format(fecha));
const diaLocal = (fecha) => formatoDia.format(fecha);

function agrupar(filas, clave) {
  const grupos = new Map();
  for (const fila of filas) {
    const k = clave(fila);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(fila);
  }
  return [...grupos.values()];
}

// Mayor cantidad de eventos dentro de una ventana deslizante, y dónde ocurrió.
function maximoEnVentana(filas, minutos) {
  const ordenadas = [...filas].sort((a, b) => a.timestamp - b.timestamp);
  let mejor = { cantidad: 0, desde: null, hasta: null };
  let inicio = 0;
  for (let fin = 0; fin < ordenadas.length; fin += 1) {
    while (ordenadas[fin].timestamp - ordenadas[inicio].timestamp > minutos * 60 * 1000) inicio += 1;
    const cantidad = fin - inicio + 1;
    if (cantidad > mejor.cantidad) mejor = { cantidad, desde: ordenadas[inicio].timestamp, hasta: ordenadas[fin].timestamp };
  }
  return mejor;
}

const extremos = (filas) => ({ desde: filas[0].timestamp, hasta: filas[filas.length - 1].timestamp });
const usuarioDe = (filas) => (filas.find((f) => f.usuarioId) || {}).usuarioId || null;

/**
 * Aplica todas las reglas a la auditoría de una ventana.
 *
 * @param {{desde: Date, hasta: Date}} ventana - a lo más 31 días.
 * @returns {Promise<Array<{regla: string, nombre: string, descripcion: string,
 *   severidad: string, responsable: string, plazoHoras: number, sujeto: string,
 *   usuarioId: ?number, usuarioNombre: ?string, cantidad: number, desde: Date, hasta: Date}>>}
 *   De la más grave a la menos grave.
 * @throws {AppError} 400 si la ventana es inválida o supera 31 días.
 *
 * Consumidores: alertaViewController.index, notificarAlertas().
 */
async function detectar({ desde, hasta }) {
  if (!(desde instanceof Date) || !(hasta instanceof Date) || Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || hasta < desde) {
    throw new AppError('Ventana de fechas inválida', 400);
  }
  if (hasta - desde > DIAS_MAXIMOS * 24 * 60 * 60 * 1000) throw new AppError(`La ventana no puede superar ${DIAS_MAXIMOS} días`, 400);

  // En orden de hora: extremos() toma la primera y la última fila de cada grupo.
  const filas = await prisma.auditLog.findMany({
    where: { timestamp: { gte: desde, lte: hasta }, accion: { in: ACCIONES } },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    select: { usuarioId: true, accion: true, entidad: true, entidadId: true, resultado: true, emailIndice: true, ip: true, timestamp: true },
  });
  const delPaciente = (f) => f.entidad === 'Paciente' || f.entidad === 'Investigacion';
  const encontradas = [];
  // sujeto: de qué trata la alerta, para reconocer la misma alerta en la
  // revisión siguiente. Un paciente va seudonimizado.
  const alerta = (regla, grupo, datos) => {
    const usuarioId = datos.usuarioId !== undefined ? datos.usuarioId : usuarioDe(grupo);
    encontradas.push({ regla, ...REGLAS[regla], sujeto: usuarioId ? `u:${usuarioId}` : 'sistema', ...datos, usuarioId });
  };

  const fallidos = filas.filter((f) => f.accion === 'LOGIN_FALLIDO');
  for (const grupo of agrupar(fallidos, (f) => (f.emailIndice ? Buffer.from(f.emailIndice).toString('hex') : `u${f.usuarioId}`))) {
    const max = maximoEnVentana(grupo, VENTANA_FALLIDOS_MIN);
    // La alerta nombra a la cuenta atacada (la entidad), si existe.
    const atacada = (grupo.find((f) => f.entidadId) || {}).entidadId || null;
    const sujeto = atacada ? `u:${atacada}` : `e:${Buffer.from(grupo[0].emailIndice || []).toString('hex').slice(0, 16)}`;
    if (max.cantidad >= UMBRAL_FALLIDOS) alerta('FALLIDOS', grupo, { ...max, usuarioId: atacada, sujeto });
  }

  const codigos = filas.filter((f) => f.accion === 'VERIFICAR_IDENTIDAD' && f.resultado === 'fallido');
  for (const grupo of agrupar(codigos, (f) => f.entidadId)) {
    const max = maximoEnVentana(grupo, VENTANA_FALLIDOS_MIN);
    if (max.cantidad >= UMBRAL_FALLIDOS) alerta('CODIGOS_FALLIDOS', grupo, { ...max, sujeto: `p:${seudonimo(grupo[0].entidadId)}` });
  }

  const accesos = filas.filter((f) => f.usuarioId && f.resultado === 'exito' && delPaciente(f) && ['READ', 'LIST', 'EXPORT', 'EXPORT_TITULAR'].includes(f.accion));
  const nocturnos = accesos.filter((f) => horaLocal(f.timestamp) < HORARIO_INICIO || horaLocal(f.timestamp) >= HORARIO_FIN);
  for (const grupo of agrupar(nocturnos, (f) => f.usuarioId)) alerta('FUERA_DE_HORARIO', grupo, { cantidad: grupo.length, ...extremos(grupo) });

  const lecturas = accesos.filter((f) => f.accion === 'READ' && f.entidadId !== 0);
  for (const grupo of agrupar(lecturas, (f) => `${f.usuarioId}|${diaLocal(f.timestamp)}|${horaLocal(f.timestamp)}`)) {
    const distintos = new Set(grupo.map((f) => f.entidadId)).size;
    if (distintos > UMBRAL_LECTURAS_HORA) alerta('VOLUMEN_LECTURAS', grupo, { cantidad: distintos, ...extremos(grupo) });
  }

  const exportaciones = filas.filter((f) => f.usuarioId && (f.accion === 'EXPORT' || f.accion === 'EXPORT_TITULAR'));
  for (const grupo of agrupar(exportaciones, (f) => `${f.usuarioId}|${diaLocal(f.timestamp)}`)) {
    if (grupo.length > UMBRAL_EXPORTACIONES_DIA) alerta('VOLUMEN_EXPORTACIONES', grupo, { cantidad: grupo.length, ...extremos(grupo) });
  }

  const negados = filas.filter((f) => f.usuarioId && f.accion === 'READ' && f.resultado === 'denegado');
  for (const grupo of agrupar(negados, (f) => f.usuarioId)) alerta('FUERA_DE_FUNCION', grupo, { cantidad: grupo.length, ...extremos(grupo) });

  const privilegios = filas.filter((f) => f.usuarioId && f.accion === 'ACCESO_DENEGADO');
  for (const grupo of agrupar(privilegios, (f) => `${f.usuarioId}|${diaLocal(f.timestamp)}`)) {
    if (grupo.length >= UMBRAL_DENEGADOS) alerta('PRIVILEGIOS_NEGADOS', grupo, { cantidad: grupo.length, ...extremos(grupo) });
  }

  const cambios = filas.filter((f) => f.usuarioId && (f.accion === 'UPDATE_PERMISOS' || f.accion === 'UPDATE_ROL' || (f.accion === 'CREATE' && f.entidad === 'Usuario')));
  for (const grupo of agrupar(cambios, (f) => f.usuarioId)) alerta('CAMBIO_DE_ACCESO', grupo, { cantidad: grupo.length, ...extremos(grupo) });

  const logins = filas.filter((f) => f.accion === 'LOGIN' && f.usuarioId && f.resultado === 'exito' && f.ip);
  if (logins.length > 0) {
    const historial = await prisma.auditLog.findMany({
      where: {
        accion: 'LOGIN',
        resultado: 'exito',
        usuarioId: { in: [...new Set(logins.map((f) => f.usuarioId))] },
        timestamp: { gte: new Date(desde.getTime() - DIAS_HISTORIAL_IP * 24 * 60 * 60 * 1000), lte: hasta },
      },
      select: { usuarioId: true, ip: true, timestamp: true },
    });
    const nuevas = logins.filter((login) => {
      const anteriores = historial.filter(
        (h) => h.usuarioId === login.usuarioId && h.timestamp < login.timestamp && login.timestamp - h.timestamp <= DIAS_HISTORIAL_IP * 24 * 60 * 60 * 1000,
      );
      return anteriores.length > 0 && !anteriores.some((h) => h.ip === login.ip);
    });
    for (const grupo of agrupar(nuevas, (f) => f.usuarioId)) alerta('IP_NUEVA', grupo, { cantidad: grupo.length, ...extremos(grupo) });
  }

  const abusoPortal = filas.filter((f) => f.accion === 'PORTAL_LIMITADO' || (f.accion === 'PORTAL_CODIGO' && f.resultado === 'denegado'));
  if (abusoPortal.length > 0) alerta('PORTAL_ABUSO', abusoPortal, { cantidad: abusoPortal.length, ...extremos(abusoPortal.sort((a, b) => a.timestamp - b.timestamp)), sujeto: 'portal' });

  const alteraciones = filas.filter((f) => f.accion === 'VERIFICAR_AUDITORIA' && f.resultado === 'fallido');
  if (alteraciones.length > 0) alerta('AUDITORIA_ALTERADA', alteraciones, { cantidad: alteraciones.length, ...extremos(alteraciones.sort((a, b) => a.timestamp - b.timestamp)), sujeto: 'sistema' });

  const ids = [...new Set(encontradas.map((a) => a.usuarioId).filter(Boolean))];
  const nombres = new Map((await prisma.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nombre: true } })).map((u) => [u.id, u.nombre]));
  return encontradas
    .map((a) => ({ ...a, usuarioNombre: a.usuarioId ? nombres.get(a.usuarioId) || null : null }))
    .sort((a, b) => SEVERIDADES.indexOf(a.severidad) - SEVERIDADES.indexOf(b.severidad));
}

// --- Alertas guardadas: responsable, plazo y revisión ----------------------

const ESTADOS_ALERTA = ['pendiente', 'descartada', 'escalada'];
const ETIQUETA_SEVERIDAD = { critica: 'crítica', alta: 'alta', media: 'media', baja: 'baja' };
const formatoAviso = new Intl.DateTimeFormat('es-CL', { timeZone: ZONA_HORARIA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Guarda las alertas detectadas. Una detección que se superpone con una
 * alerta pendiente de la misma regla y el mismo sujeto la amplía (no la
 * duplica); si esa alerta ya se revisó, solo actividad posterior a ella crea
 * una alerta nueva.
 *
 * @param {Array<object>} detectadas - salida de detectar().
 * @param {Date} ahora - la hora de la detección; el plazo corre desde aquí.
 * @returns {Promise<{nuevas: Array<object>, actualizadas: number}>}
 *
 * Consumidores: analizar().
 */
async function persistir(detectadas, ahora) {
  const nuevas = [];
  let actualizadas = 0;
  for (const a of detectadas) {
    const previa = await prisma.alerta.findFirst({ where: { regla: a.regla, sujeto: a.sujeto }, orderBy: { hasta: 'desc' } });
    const seSuperpone = previa && a.desde <= previa.hasta;
    if (seSuperpone && previa.estado === 'pendiente') {
      await prisma.alerta.update({
        where: { id: previa.id },
        data: {
          desde: a.desde < previa.desde ? a.desde : previa.desde,
          hasta: a.hasta > previa.hasta ? a.hasta : previa.hasta,
          cantidad: Math.max(previa.cantidad, a.cantidad),
        },
      });
      actualizadas += 1;
      continue;
    }
    if (seSuperpone && a.hasta <= previa.hasta) continue;
    nuevas.push(
      await prisma.alerta.create({
        data: {
          regla: a.regla,
          sujeto: a.sujeto,
          usuarioId: a.usuarioId,
          cantidad: a.cantidad,
          desde: a.desde,
          hasta: a.hasta,
          severidad: a.severidad,
          responsable: a.responsable,
          detectadaEl: ahora,
          revisarAntesDe: new Date(ahora.getTime() + a.plazoHoras * 60 * 60 * 1000),
        },
      }),
    );
  }
  return { nuevas, actualizadas };
}

/**
 * Aplica las reglas a una ventana y guarda lo que encuentra.
 *
 * @param {{desde: Date, hasta: Date}} ventana - a lo más 31 días.
 * @param {Date} [ahora]
 * @returns {Promise<{detectadas: number, nuevas: Array<object>, actualizadas: number}>}
 * @throws {AppError} 400 si la ventana es inválida.
 *
 * Consumidores: notificarAlertas(), alertaViewController.analizar.
 */
async function analizar(ventana, ahora = new Date()) {
  const detectadas = await detectar(ventana);
  const { nuevas, actualizadas } = await persistir(detectadas, ahora);
  return { detectadas: detectadas.length, nuevas, actualizadas };
}

/**
 * Las alertas guardadas, de la más urgente a la menos: pendientes primero
 * (por severidad y plazo), después las revisadas más recientes.
 *
 * @param {{estado?: string, ahora?: Date}} [filtro] - estado: 'pendiente',
 *   'descartada', 'escalada' o nada (todas).
 * @returns {Promise<Array<object>>} cada una con nombre y descripción de su
 *   regla, el nombre de la cuenta y si venció su plazo.
 *
 * Consumidores: alertaViewController.index.
 */
async function listar({ estado, ahora = new Date() } = {}) {
  const filas = await prisma.alerta.findMany({
    where: ESTADOS_ALERTA.includes(estado) ? { estado } : {},
    include: { usuario: { select: { nombre: true } }, revisadaPor: { select: { nombre: true } } },
    orderBy: [{ revisarAntesDe: 'asc' }],
    take: 500,
  });
  const rango = (f) => (f.estado === 'pendiente' ? 0 : 1);
  return filas
    .map((f) => ({
      ...f,
      nombre: REGLAS[f.regla] ? REGLAS[f.regla].nombre : f.regla,
      descripcion: REGLAS[f.regla] ? REGLAS[f.regla].descripcion : '',
      usuarioNombre: f.usuario ? f.usuario.nombre : null,
      revisadaPorNombre: f.revisadaPor ? f.revisadaPor.nombre : null,
      vencida: f.estado === 'pendiente' && f.revisarAntesDe < ahora,
    }))
    .sort(
      (a, b) =>
        rango(a) - rango(b) ||
        (rango(a) === 0 ? SEVERIDADES.indexOf(a.severidad) - SEVERIDADES.indexOf(b.severidad) || a.revisarAntesDe - b.revisarAntesDe : b.revisadaEl - a.revisadaEl),
    );
}

/**
 * Una alerta que el usuario puede revisar: pendiente, y que no trate de su
 * propia cuenta (nadie revisa una alerta sobre sí mismo).
 *
 * @param {number} id
 * @param {{id: number}} revisor
 * @param {object} [client] - prisma o una transacción.
 * @returns {Promise<object>} la alerta.
 * @throws {AppError} 404 si no existe; 409 si ya se revisó; 403 si es sobre
 *   la cuenta del revisor.
 *
 * Consumidores: descartar(), incidenteService.registrarIncidente (escalar).
 */
async function alertaParaRevisar(id, revisor, client = prisma) {
  const alerta = await client.alerta.findUnique({ where: { id } });
  if (!alerta) throw new AppError('Alerta no encontrada', 404);
  if (alerta.estado !== 'pendiente') throw new AppError('La alerta ya se revisó', 409);
  if (alerta.usuarioId === revisor.id) throw new AppError('No puedes revisar una alerta sobre tu propia cuenta: la revisa otra persona', 403);
  return alerta;
}

/**
 * Descarta una alerta (un falso positivo, o una actividad autorizada), con
 * el motivo. Escalarla a un incidente se hace al registrarlo
 * (incidenteService.registrarIncidente con alertaId).
 *
 * @param {number} id
 * @param {string} motivo - entre 10 y 500 caracteres, sin datos de pacientes.
 * @param {{id: number}} revisor - req.usuario (alertas.revisar).
 * @returns {Promise<void>}
 * @throws {AppError} 400 si falta el motivo; ver alertaParaRevisar().
 *
 * Consumidores: alertaViewController.descartar.
 */
async function descartar(id, motivo, revisor) {
  const texto = typeof motivo === 'string' ? motivo.trim() : '';
  if (texto.length < 10 || texto.length > 500) throw new AppError('Indica por qué se descarta (entre 10 y 500 caracteres)', 400);
  await prisma.$transaction(async (tx) => {
    await alertaParaRevisar(id, revisor, tx);
    // Condicional: si otra persona la revisó entre la lectura y esta línea, no se pisa su revisión.
    const { count } = await tx.alerta.updateMany({ where: { id, estado: 'pendiente' }, data: { estado: 'descartada', motivo: texto, revisadaPorId: revisor.id, revisadaEl: new Date() } });
    if (count !== 1) throw new AppError('La alerta ya se revisó', 409);
    await registrar({ usuarioId: revisor.id, accion: 'REVISAR_ALERTA', entidad: 'Alerta', entidadId: id, detalle: { resultado: 'descartada' } }, tx);
  });
}

async function destinatarios(rolNombre, excluirId) {
  const activos = { suspendida: false, ...(excluirId ? { id: { not: excluirId } } : {}) };
  const delRol = await prisma.usuario.findMany({ where: { ...activos, rol: { nombre: rolNombre } }, select: { id: true } });
  if (delRol.length > 0) return delRol;
  // Sin nadie en el rol responsable, avisa a todos los que revisan alertas.
  return prisma.usuario.findMany({ where: { ...activos, rol: { permisos: { some: { permiso: { clave: 'alertas.revisar' } } } } }, select: { id: true } });
}

/**
 * Revisa las últimas 24 horas, guarda las alertas y avisa a su responsable
 * (el rol de la regla), con la severidad y el plazo. Las que vencieron sin
 * revisarse se escalan una vez a privacidad. Los avisos no identifican a
 * nadie: dicen la regla, el número de la alerta y el plazo.
 *
 * @param {Date} [ahora]
 * @returns {Promise<{alertas: number, nuevas: number, vencidas: number, avisados: number}>}
 *
 * Consumidores: src/alertas.js (npm run alertas, cada hora).
 */
async function notificarAlertas(ahora = new Date()) {
  const { detectadas, nuevas } = await analizar({ desde: new Date(ahora.getTime() - 24 * 60 * 60 * 1000), hasta: ahora }, ahora);
  let avisados = 0;
  for (const a of nuevas) {
    const mensaje = `Alerta ${ETIQUETA_SEVERIDAD[a.severidad]} N° ${a.id}: ${REGLAS[a.regla].nombre}. Revísala en Alertas antes del ${formatoAviso.format(a.revisarAntesDe)}.`;
    for (const { id } of await destinatarios(a.responsable, a.usuarioId)) {
      await crearNotificacion({ usuarioId: id, mensaje });
      avisados += 1;
    }
  }

  const vencidas = await prisma.alerta.findMany({ where: { estado: 'pendiente', revisarAntesDe: { lt: ahora }, vencidaAvisadaEl: null } });
  for (const a of vencidas) {
    const mensaje = `La alerta ${ETIQUETA_SEVERIDAD[a.severidad]} N° ${a.id} (${REGLAS[a.regla] ? REGLAS[a.regla].nombre : a.regla}) venció sin revisarse: revísala en Alertas.`;
    for (const { id } of await destinatarios('privacidad', a.usuarioId)) {
      await crearNotificacion({ usuarioId: id, mensaje });
      avisados += 1;
    }
    await prisma.alerta.update({ where: { id: a.id }, data: { vencidaAvisadaEl: ahora } });
  }

  const resumen = { alertas: detectadas, nuevas: nuevas.length, vencidas: vencidas.length, avisados };
  await registrar({ actor: 'sistema', accion: 'ALERTAS', entidad: 'Sistema', entidadId: 0, detalle: resumen });
  return resumen;
}

module.exports = { REGLAS, SEVERIDADES, ESTADOS_ALERTA, DIAS_MAXIMOS, detectar, analizar, listar, alertaParaRevisar, descartar, notificarAlertas };
