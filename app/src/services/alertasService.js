const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { registrar } = require('./auditService');
const { crearNotificacion } = require('./notificacionService');

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

const REGLAS = {
  FALLIDOS: { nombre: 'Inicios de sesión fallidos', descripcion: `${UMBRAL_FALLIDOS} o más intentos fallidos sobre una misma cuenta en ${VENTANA_FALLIDOS_MIN} minutos.` },
  CODIGOS_FALLIDOS: { nombre: 'Códigos de verificación fallidos', descripcion: `${UMBRAL_FALLIDOS} o más códigos incorrectos sobre un mismo paciente en ${VENTANA_FALLIDOS_MIN} minutos.` },
  FUERA_DE_HORARIO: { nombre: 'Fuera de horario', descripcion: `Accesos a datos de pacientes entre las ${HORARIO_FIN}:00 y las ${HORARIO_INICIO}:00.` },
  VOLUMEN_LECTURAS: { nombre: 'Volumen de lecturas', descripcion: `Más de ${UMBRAL_LECTURAS_HORA} pacientes distintos leídos en una misma hora.` },
  VOLUMEN_EXPORTACIONES: { nombre: 'Volumen de exportaciones', descripcion: `Más de ${UMBRAL_EXPORTACIONES_DIA} exportaciones en un mismo día.` },
  FUERA_DE_FUNCION: { nombre: 'Acceso negado', descripcion: 'Intentos de ver datos de pacientes fuera de la función o el alcance del usuario.' },
  CAMBIO_DE_ACCESO: { nombre: 'Cambio de accesos (informativa)', descripcion: 'Creación de cuentas y cambios de rol o de permisos: confirmar que respondan a un proceso autorizado.' },
};

const ACCIONES = ['LOGIN_FALLIDO', 'VERIFICAR_IDENTIDAD', 'READ', 'LIST', 'EXPORT', 'EXPORT_TITULAR', 'UPDATE_PERMISOS', 'UPDATE_ROL', 'CREATE'];

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
 *   usuarioId: ?number, usuarioNombre: ?string, cantidad: number, desde: Date, hasta: Date}>>}
 * @throws {AppError} 400 si la ventana es inválida o supera 31 días.
 *
 * Consumidores: alertaViewController.index, notificarAlertas().
 */
async function detectar({ desde, hasta }) {
  if (!(desde instanceof Date) || !(hasta instanceof Date) || Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || hasta < desde) {
    throw new AppError('Ventana de fechas inválida', 400);
  }
  if (hasta - desde > DIAS_MAXIMOS * 24 * 60 * 60 * 1000) throw new AppError(`La ventana no puede superar ${DIAS_MAXIMOS} días`, 400);

  const filas = await prisma.auditLog.findMany({
    where: { timestamp: { gte: desde, lte: hasta }, accion: { in: ACCIONES } },
    select: { usuarioId: true, accion: true, entidad: true, entidadId: true, resultado: true, emailIndice: true, timestamp: true },
  });
  const delPaciente = (f) => f.entidad === 'Paciente' || f.entidad === 'Investigacion';
  const encontradas = [];
  const alerta = (regla, grupo, datos) => encontradas.push({ regla, ...REGLAS[regla], usuarioId: usuarioDe(grupo), ...datos });

  const fallidos = filas.filter((f) => f.accion === 'LOGIN_FALLIDO');
  for (const grupo of agrupar(fallidos, (f) => (f.emailIndice ? Buffer.from(f.emailIndice).toString('hex') : `u${f.usuarioId}`))) {
    const max = maximoEnVentana(grupo, VENTANA_FALLIDOS_MIN);
    if (max.cantidad >= UMBRAL_FALLIDOS) alerta('FALLIDOS', grupo, max);
  }

  const codigos = filas.filter((f) => f.accion === 'VERIFICAR_IDENTIDAD' && f.resultado === 'fallido');
  for (const grupo of agrupar(codigos, (f) => f.entidadId)) {
    const max = maximoEnVentana(grupo, VENTANA_FALLIDOS_MIN);
    if (max.cantidad >= UMBRAL_FALLIDOS) alerta('CODIGOS_FALLIDOS', grupo, max);
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

  const cambios = filas.filter((f) => f.usuarioId && (f.accion === 'UPDATE_PERMISOS' || f.accion === 'UPDATE_ROL' || (f.accion === 'CREATE' && f.entidad === 'Usuario')));
  for (const grupo of agrupar(cambios, (f) => f.usuarioId)) alerta('CAMBIO_DE_ACCESO', grupo, { cantidad: grupo.length, ...extremos(grupo) });

  const ids = [...new Set(encontradas.map((a) => a.usuarioId).filter(Boolean))];
  const nombres = new Map((await prisma.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nombre: true } })).map((u) => [u.id, u.nombre]));
  return encontradas.map((a) => ({ ...a, usuarioNombre: a.usuarioId ? nombres.get(a.usuarioId) || null : null }));
}

/**
 * Revisa las últimas 24 horas y, si hay alertas, avisa a quienes auditan
 * (permiso auditoria.read). El aviso solo dice cuántas hay.
 *
 * @param {Date} [ahora]
 * @returns {Promise<{alertas: number, avisados: number}>}
 *
 * Consumidores: src/alertas.js (npm run alertas).
 */
async function notificarAlertas(ahora = new Date()) {
  const lista = await detectar({ desde: new Date(ahora.getTime() - 24 * 60 * 60 * 1000), hasta: ahora });
  let avisados = 0;
  if (lista.length > 0) {
    const auditores = await prisma.usuario.findMany({
      where: { rol: { permisos: { some: { permiso: { clave: 'auditoria.read' } } } } },
      select: { id: true },
    });
    for (const { id } of auditores) {
      await crearNotificacion({ usuarioId: id, mensaje: `MediBox detectó ${lista.length} alerta${lista.length === 1 ? '' : 's'} de accesos anómalos en las últimas 24 horas: revisa Alertas.` });
      avisados += 1;
    }
  }
  const resumen = { alertas: lista.length, avisados };
  await registrar({ actor: 'sistema', accion: 'ALERTAS', entidad: 'Sistema', entidadId: 0, detalle: resumen });
  return resumen;
}

module.exports = { REGLAS, DIAS_MAXIMOS, detectar, notificarAlertas };
