const crypto = require('crypto');

// Cifrado de campos sensibles a nivel de aplicación con AES-256-GCM.
//
// El cifrado ocurre en el proceso Node: PostgreSQL solo recibe y guarda el
// blob ya cifrado, y la llave nunca viaja dentro de una consulta SQL (con
// pgcrypto la llave era un parámetro más de la sentencia y podía terminar en
// los logs del servidor de base de datos).
//
// Formato del blob: [versión 1B][IV 12B][tag 16B][texto cifrado]. El byte de
// versión permite cambiar de llave o de algoritmo más adelante sin ambigüedad
// sobre cómo leer los datos ya guardados.

const ALGORITMO = 'aes-256-gcm';
const VERSION_FORMATO = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CABECERA_BYTES = 1 + IV_BYTES + TAG_BYTES;
const LLAVE_BYTES = 32;

// Qué variable de entorno protege cada campo. Identidad, contacto y datos
// clínicos usan llaves distintas: filtrar una no expone las otras categorías.
// El nombre del campo se usa además como AAD, así que un blob copiado de una
// columna a otra no pasa la verificación aunque ambas compartan llave.
const LLAVE_POR_CAMPO = {
  'paciente.nombre': 'PACIENTE_IDENTIDAD_KEY',
  'paciente.rut': 'PACIENTE_IDENTIDAD_KEY',
  'paciente.contacto': 'PACIENTE_CONTACTO_KEY',
  'paciente.motivoConsulta': 'PACIENTE_CLINICO_KEY',
};

// Llave del índice ciego (HMAC). Separada de las de cifrado: quien tenga esta
// llave puede comprobar si un RUT existe, pero no descifrar nada.
const LLAVE_INDICE_POR_CAMPO = {
  'paciente.rut': 'PACIENTE_RUT_HMAC_KEY',
};

const VARIABLES_DE_LLAVE = [
  ...new Set([...Object.values(LLAVE_POR_CAMPO), ...Object.values(LLAVE_INDICE_POR_CAMPO)]),
];

/**
 * Lee y valida una llave de 32 bytes en base64 desde el entorno.
 * El mensaje de error nombra la variable, nunca su valor.
 *
 * @param {string} variable - nombre de la variable de entorno.
 * @returns {Buffer} la llave decodificada.
 * @throws {Error} si falta, no es base64 válido o no mide 32 bytes.
 */
function leerLlave(variable) {
  const valor = (process.env[variable] || '').trim();
  const llave = Buffer.from(valor, 'base64');
  if (llave.length !== LLAVE_BYTES || llave.toString('base64') !== valor) {
    throw new Error(`${variable} debe ser una llave de ${LLAVE_BYTES} bytes codificada en base64`);
  }
  return llave;
}

function variableDe(registro, campo) {
  const variable = registro[campo];
  if (!variable) throw new Error(`No hay llave registrada para el campo ${campo}`);
  return variable;
}

/**
 * Cifra un texto con la llave asignada a su campo.
 *
 * @param {string} campo - clave de LLAVE_POR_CAMPO, p. ej. 'paciente.rut'.
 * @param {string} texto - valor en claro.
 * @returns {Buffer} blob versionado listo para guardar en una columna BYTEA.
 *   Dos llamadas con el mismo texto devuelven blobs distintos (IV aleatorio).
 *
 * Consumidores: services/pacienteService.js, prisma/migrar-cifrado.js.
 */
function cifrar(campo, texto) {
  const llave = leerLlave(variableDe(LLAVE_POR_CAMPO, campo));
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITMO, llave, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(campo, 'utf8'));
  const cifrado = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION_FORMATO]), iv, cipher.getAuthTag(), cifrado]);
}

/**
 * Descifra un blob producido por cifrar() para el mismo campo.
 *
 * @param {string} campo - el mismo campo usado al cifrar.
 * @param {Buffer} blob - contenido de la columna cifrada.
 * @returns {string} el texto original.
 * @throws {Error} si el formato es desconocido, la llave no corresponde o el
 *   blob fue alterado (GCM verifica integridad antes de devolver nada).
 *
 * Consumidores: services/pacienteService.js.
 */
function descifrar(campo, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < CABECERA_BYTES || blob[0] !== VERSION_FORMATO) {
    throw new Error(`Formato cifrado desconocido en ${campo}`);
  }
  const llave = leerLlave(variableDe(LLAVE_POR_CAMPO, campo));
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, CABECERA_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITMO, llave, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(campo, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(CABECERA_BYTES)), decipher.final()]).toString('utf8');
}

/**
 * Calcula el índice ciego (HMAC-SHA256) de un valor, para buscarlo o exigir
 * unicidad sin descifrar. Es determinista: el mismo valor da el mismo índice,
 * por eso el llamador debe normalizar el valor antes.
 *
 * @param {string} campo - clave de LLAVE_INDICE_POR_CAMPO, p. ej. 'paciente.rut'.
 * @param {string} valor - valor ya normalizado.
 * @returns {Buffer} 32 bytes.
 *
 * Consumidores: services/pacienteService.js.
 */
function indiceCiego(campo, valor) {
  const llave = leerLlave(variableDe(LLAVE_INDICE_POR_CAMPO, campo));
  return crypto.createHmac('sha256', llave).update(valor, 'utf8').digest();
}

/**
 * Revisa que todas las llaves registradas existan, sean válidas y no se
 * repitan entre variables (reutilizar una llave anula la separación).
 *
 * @returns {string[]} problemas encontrados; vacío si todo está bien.
 *
 * Consumidores: lib/entorno.js (validación al arrancar el servidor).
 */
function revisarLlaves() {
  const problemas = [];
  const vistas = new Map();
  for (const variable of VARIABLES_DE_LLAVE) {
    try {
      const codificada = leerLlave(variable).toString('base64');
      if (vistas.has(codificada)) {
        problemas.push(`${variable} repite la llave de ${vistas.get(codificada)}`);
      } else {
        vistas.set(codificada, variable);
      }
    } catch (err) {
      problemas.push(err.message);
    }
  }
  return problemas;
}

module.exports = { cifrar, descifrar, indiceCiego, revisarLlaves, VARIABLES_DE_LLAVE };
