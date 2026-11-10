const fs = require('fs');
const path = require('path');
const { logger } = require('../lib/logger');
const { registrar } = require('./auditService');

// Anotaciones que sobreviven a una restauración (Hito 3).
//
// Los respaldos cifrados no se editan: rotan a los 30 días (ops/respaldar-db.sh).
// Restaurar uno anterior deshace lo que el titular pidió después de esa copia:
// resucita un contacto suprimido, levanta un bloqueo y vuelve a permitir un uso
// al que se opuso. Por eso cada una de esas decisiones queda anotada en un
// archivo fuera de la base y de sus respaldos (solo ids, fecha, tipo y, en una
// revocación, el uso y el canal; nunca un dato personal), y
// ops/restaurar-db.sh la vuelve a aplicar (supresionService.reaplicar).
//
// Una línea por anotación (JSON):
//   - supresión:  { pacienteId, fecha, solicitudId }        (sin `tipo`, como siempre)
//   - bloqueo, desbloqueo, revocacion: { tipo, pacienteId, fecha, solicitudId?, finalidad?, canal? }
//   - depuracion (eliminación de un paciente al cumplirse el plazo legal): { tipo, pacienteId, fecha }
// La rectificación no se anota: reaplicarla exigiría guardar el valor nuevo,
// un dato personal fuera de la base. Se revisa desde la auditoría.

const TIPOS = ['supresion', 'bloqueo', 'desbloqueo', 'revocacion', 'depuracion'];
const DIAS_RESPALDO_POR_OMISION = 30;
const MS_DIA = 24 * 60 * 60 * 1000;

function archivo() {
  return process.env.SUPRESIONES_ARCHIVO || path.join(__dirname, '..', '..', 'registro', 'supresiones.jsonl');
}

// Los mismos días que conserva ops/respaldar-db.sh: más allá de ellos no queda
// ningún respaldo anterior a lo anotado, y anotarlo ya no sirve.
function diasDeRespaldo() {
  const dias = Number(process.env.MEDIBOX_RESPALDO_DIAS);
  return Number.isInteger(dias) && dias > 0 ? dias : DIAS_RESPALDO_POR_OMISION;
}

function agregar(anotacion) {
  fs.mkdirSync(path.dirname(archivo()), { recursive: true });
  fs.appendFileSync(archivo(), `${JSON.stringify(anotacion)}\n`);
}

/**
 * Anota una supresión ejecutada.
 *
 * @param {number} pacienteId
 * @param {number} solicitudId
 * @returns {void}
 * @throws {Error} si no se puede escribir el archivo.
 *
 * Consumidores: derechosService.ejecutar (supresión), supresionService.
 */
function registrarSupresion(pacienteId, solicitudId) {
  agregar({ pacienteId, fecha: new Date().toISOString(), solicitudId });
}

/**
 * Anota un bloqueo, su levantamiento, una revocación de consentimiento o una
 * depuración, para reaplicarlo si se restaura un respaldo anterior. Se llama cuando el
 * cambio ya se confirmó en la base: nunca dentro de su transacción, o una
 * anulada dejaría anotado algo que no ocurrió. Un fallo no se le devuelve a
 * quien ejerció su derecho (ya está aplicado y respondido): queda en el log y
 * en la auditoría como fallido, para que el administrador lo anote a mano
 * antes de cualquier restauración.
 *
 * @param {{tipo: ('bloqueo'|'desbloqueo'|'revocacion'|'depuracion'), pacienteId: number,
 *   solicitudId?: number, finalidad?: string, canal?: string}} datos -
 *   finalidad vacía en una revocación significa todas las finalidades.
 * @returns {Promise<boolean>} si quedó anotada.
 *
 * Consumidores: derechosService.ejecutar y desbloquear,
 *   consentimientoService.revocar, portalService.revocar,
 *   depuracionService.depurar.
 */
async function anotarRestriccion({ tipo, pacienteId, solicitudId, finalidad, canal }) {
  try {
    agregar({
      tipo,
      pacienteId,
      fecha: new Date().toISOString(),
      ...(solicitudId ? { solicitudId } : {}),
      ...(finalidad ? { finalidad } : {}),
      ...(canal ? { canal } : {}),
    });
    return true;
  } catch (err) {
    logger.error({ err: { code: err.code }, tipo }, 'No se pudo anotar la restricción en registro/supresiones.jsonl');
    await registrar({
      actor: 'sistema',
      accion: 'ANOTAR_RESTRICCION',
      entidad: 'Paciente',
      entidadId: pacienteId,
      resultado: 'fallido',
      detalle: { tipo, ...(solicitudId ? { solicitudId } : {}) },
    });
    return false;
  }
}

/**
 * Todas las anotaciones, en el orden en que ocurrieron. Una línea sin `tipo`
 * es una supresión (el formato original).
 *
 * @returns {Array<{tipo: string, pacienteId: number, fecha: string,
 *   solicitudId?: number, finalidad?: string, canal?: string}>}
 *
 * Consumidores: supresionService.reaplicar.
 */
function leerAnotaciones() {
  if (!fs.existsSync(archivo())) return [];
  return fs
    .readFileSync(archivo(), 'utf8')
    .split('\n')
    .filter((linea) => linea.trim())
    .map((linea) => {
      const anotacion = JSON.parse(linea);
      return { ...anotacion, tipo: TIPOS.includes(anotacion.tipo) ? anotacion.tipo : 'supresion' };
    });
}

/**
 * Quita las anotaciones más antiguas que la vigencia de los respaldos (más un
 * día de margen): ya no existe una copia anterior que las necesite, y el
 * archivo no debe guardar para siempre quién ejerció un derecho.
 *
 * Reescribe el archivo completo y lo reemplaza de una vez. Si alguien anotó
 * algo mientras tanto (el tamaño cambió), lo deja para la próxima pasada.
 *
 * @param {Date} [ahora]
 * @returns {number} anotaciones eliminadas.
 *
 * Consumidores: retencionService.aplicarRetencion.
 */
function podarAnotaciones(ahora = new Date()) {
  if (!fs.existsSync(archivo())) return 0;
  const limite = ahora.getTime() - (diasDeRespaldo() + 1) * MS_DIA;
  const contenido = fs.readFileSync(archivo());
  const lineas = contenido.toString('utf8').split('\n').filter((linea) => linea.trim());
  const vigentes = lineas.filter((linea) => new Date(JSON.parse(linea).fecha).getTime() >= limite);
  if (vigentes.length === lineas.length) return 0;

  // ponytail: entre este chequeo y el reemplazo queda una ventana de
  // milisegundos en la que una anotación nueva se perdería. Upgrade: un
  // archivo de bloqueo (flock) que compartan agregar() y esta función.
  if (fs.statSync(archivo()).size !== contenido.length) return 0;
  const temporal = `${archivo()}.${process.pid}.tmp`;
  fs.writeFileSync(temporal, vigentes.map((linea) => `${linea}\n`).join(''), { mode: 0o600 });
  fs.renameSync(temporal, archivo());
  return lineas.length - vigentes.length;
}

module.exports = { registrarSupresion, anotarRestriccion, leerAnotaciones, podarAnotaciones };
