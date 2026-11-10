const path = require('path');
const { spawn } = require('child_process');
const { setTimeout, clearTimeout } = require('timers');
const { logger } = require('./logger');

// Programador de los procesos de operación (Hito 3): alertas, copia y
// verificación de la auditoría, plazos de conservación, recordatorios y
// encuestas. Registrar no basta si nadie lo revisa: sin algo que los corra,
// las reglas de alerta existen pero nunca se evalúan. Lo corre el servicio
// `tareas` de docker-compose.yml, sin cron ni dependencias nuevas.
//
// Cada tarea ejecuta el mismo script que se puede correr a mano con
// `npm run ...`, en su propio proceso. Las horas son las locales del servidor
// (TZ, America/Santiago en docker-compose.yml).

// cadaMinutos: se alinea con el reloj (:00, :15, :30, :45...). diaria: "HH:MM" local.
const TAREAS = [
  { nombre: 'auditoria:copiar', script: 'auditoria-copiar.js', cadaMinutos: 15 },
  // La detección corre cada hora. Los vencimientos de solicitudes, una vez al
  // día: cada aviso es una notificación a privacidad y no se deduplica.
  { nombre: 'alertas', script: 'alertas.js', args: ['--solo-alertas'], cadaMinutos: 60 },
  { nombre: 'vencimientos', script: 'alertas.js', args: ['--solo-vencimientos'], diaria: '08:00' },
  { nombre: 'retencion', script: 'retencion.js', diaria: '02:00' },
  { nombre: 'auditoria:verificar', script: 'auditoria-verificar.js', diaria: '03:00' },
  { nombre: 'encuestas', script: 'encuestas.js', diaria: '09:00' },
  // La víspera: los recordatorios son de las citas de mañana.
  { nombre: 'recordatorios', script: 'recordatorios.js', diaria: '18:00' },
];

const MINUTOS_MAXIMOS_POR_OMISION = 30;

/**
 * Cuándo corre la tarea la próxima vez: siempre después de `desde`.
 *
 * @param {{cadaMinutos?: number, diaria?: string}} tarea
 * @param {Date} [desde]
 * @returns {Date}
 *
 * Consumidores: crearProgramador().
 */
function proximaEjecucion(tarea, desde = new Date()) {
  if (tarea.cadaMinutos) {
    const paso = tarea.cadaMinutos * 60 * 1000;
    const medianoche = new Date(desde);
    medianoche.setHours(0, 0, 0, 0);
    return new Date(medianoche.getTime() + (Math.floor((desde - medianoche) / paso) + 1) * paso);
  }
  const [hora, minuto] = tarea.diaria.split(':').map(Number);
  const hoy = new Date(desde);
  hoy.setHours(hora, minuto, 0, 0);
  if (hoy > desde) return hoy;
  const manana = new Date(desde);
  manana.setDate(manana.getDate() + 1);
  manana.setHours(hora, minuto, 0, 0);
  return manana;
}

/**
 * Corre el script de una tarea en su propio proceso, con la salida y el
 * entorno de este. Si no termina en `maxMinutos`, lo corta.
 *
 * @param {{nombre: string, script: string, args?: string[], maxMinutos?: number}} tarea -
 *   script: ruta relativa a src/ (o absoluta).
 * @returns {Promise<{codigo: ?number, vencida?: boolean}>} el código con que
 *   terminó; null y vencida si hubo que cortarlo.
 *
 * Consumidores: crearProgramador().
 */
function ejecutarScript(tarea) {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(process.execPath, [path.resolve(__dirname, '..', tarea.script), ...(tarea.args || [])], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
    let vencida = false;
    const limite = setTimeout(() => {
      vencida = true;
      hijo.kill('SIGTERM');
    }, (tarea.maxMinutos || MINUTOS_MAXIMOS_POR_OMISION) * 60 * 1000);
    hijo.on('error', (err) => {
      clearTimeout(limite);
      rechazar(err);
    });
    hijo.on('close', (codigo) => {
      clearTimeout(limite);
      resolver(vencida ? { codigo: null, vencida: true } : { codigo });
    });
  });
}

/**
 * Programa las tareas: cada una corre a su hora, una a la vez (si la anterior
 * sigue en curso, se omite), y un fallo se registra sin detener a las demás.
 * Los relojes y el lanzador se pueden inyectar, para probarlo sin esperar.
 *
 * @param {object} [opciones]
 * @param {object[]} [opciones.tareas]
 * @param {function} [opciones.ejecutar] - (tarea) => Promise<{codigo}>.
 * @param {function} [opciones.ahora] - () => Date.
 * @param {function} [opciones.setTimer] - como setTimeout.
 * @param {function} [opciones.clearTimer] - como clearTimeout.
 * @param {object} [opciones.log] - info, warn y error, como pino.
 * @returns {{iniciar: function, detener: function, correr: function}}
 *
 * Consumidores: src/tareas.js.
 */
function crearProgramador({ tareas = TAREAS, ejecutar = ejecutarScript, ahora = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, log = logger } = {}) {
  const enCurso = new Set();
  const temporizadores = new Map();
  let detenido = false;

  async function correr(tarea) {
    if (enCurso.has(tarea.nombre)) {
      log.warn({ tarea: tarea.nombre }, 'Tarea omitida: la ejecución anterior sigue en curso');
      return { omitida: true };
    }
    enCurso.add(tarea.nombre);
    try {
      const resultado = await ejecutar(tarea);
      if (resultado.codigo === 0) log.info({ tarea: tarea.nombre }, 'Tarea terminada');
      else log.error({ tarea: tarea.nombre, ...resultado }, 'La tarea terminó con error');
      return resultado;
    } catch (err) {
      log.error({ err, tarea: tarea.nombre }, 'La tarea no pudo ejecutarse');
      return { codigo: null, error: true };
    } finally {
      enCurso.delete(tarea.nombre);
    }
  }

  function programar(tarea) {
    if (detenido) return;
    const espera = proximaEjecucion(tarea, ahora()) - ahora();
    temporizadores.set(
      tarea.nombre,
      setTimer(async () => {
        if (detenido) return;
        await correr(tarea);
        programar(tarea);
      }, espera),
    );
  }

  return {
    iniciar: () => tareas.forEach(programar),
    detener: () => {
      detenido = true;
      temporizadores.forEach((t) => clearTimer(t));
    },
    correr,
  };
}

module.exports = { TAREAS, proximaEjecucion, ejecutarScript, crearProgramador };
