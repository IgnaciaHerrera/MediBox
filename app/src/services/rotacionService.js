const { prisma } = require('../lib/prisma');
const { cifrarCon, descifrarCon, hmacCon, variableDeCampo, descifrar, LLAVE_BYTES } = require('../lib/cifrado');
const { normalizarRut } = require('../lib/rut');
const { registrar } = require('./auditService');

// Rotación de llaves (plan de respuesta a incidentes, Hito 3): si una llave
// se filtra, se recifra con una nueva todo lo que protege.
//
// ponytail: la rotación se hace con la app detenida, en una sola
// transacción. El upgrade, para rotar en caliente, es guardar en el byte de
// versión del formato qué llave cifró cada blob y aceptar ambas mientras dura.
//
// Columnas cifradas de la base. `campo` es el AAD (y la llave) de cada
// valor; para el historial y las solicitudes depende de la fila.
const COLUMNAS_CIFRADAS = [
  { modelo: 'paciente', columna: 'nombreCifrado', campo: () => 'paciente.nombre' },
  { modelo: 'paciente', columna: 'rutCifrado', campo: () => 'paciente.rut' },
  { modelo: 'paciente', columna: 'fechaNacimientoCifrada', campo: () => 'paciente.fechaNacimiento' },
  { modelo: 'paciente', columna: 'contactoCifrado', campo: () => 'paciente.contacto' },
  { modelo: 'cita', columna: 'motivoConsultaCifrado', campo: () => 'cita.motivoConsulta' },
  { modelo: 'historialCambio', columna: 'valorAnteriorCifrado', extra: 'campo', campo: (f) => `historial.${f.campo}` },
  { modelo: 'consentimiento', columna: 'representanteCifrado', campo: () => 'consentimiento.representante' },
  { modelo: 'solicitudDerecho', columna: 'valorPropuestoCifrado', extra: 'campo', campo: (f) => `solicitud.valor.${f.campo}` },
  { modelo: 'solicitudDerecho', columna: 'respuestaCifrada', campo: () => 'solicitud.respuesta' },
  { modelo: 'solicitudDerecho', columna: 'prorrogaMotivoCifrado', campo: () => 'solicitud.prorroga' },
];

// Llaves que no tienen nada rotable en la base:
//   - PACIENTE_SEUDONIMO_KEY no se guarda en ninguna columna; cambiarla solo
//     rompe la continuidad de los seudónimos de los archivos ya exportados.
//   - AUDITORIA_HMAC_KEY: la auditoría es de solo inserción; con una llave
//     nueva los intentos fallidos se cuentan desde cero.
const SIN_DATOS_ROTABLES = ['PACIENTE_SEUDONIMO_KEY', 'AUDITORIA_HMAC_KEY'];
const ROTABLES = ['PACIENTE_IDENTIDAD_KEY', 'PACIENTE_CONTACTO_KEY', 'PACIENTE_CLINICO_KEY', 'PACIENTE_RUT_HMAC_KEY'];

function validarLlave(llave, nombre) {
  if (!Buffer.isBuffer(llave) || llave.length !== LLAVE_BYTES) throw new Error(`${nombre} debe ser una llave de ${LLAVE_BYTES} bytes`);
}

async function recifrarColumnas(variable, { llaveAnterior, llaveNueva }, tx) {
  let filas = 0;
  for (const spec of COLUMNAS_CIFRADAS) {
    const registros = await tx[spec.modelo].findMany({
      select: { id: true, [spec.columna]: true, ...(spec.extra ? { [spec.extra]: true } : {}) },
    });
    for (const registro of registros) {
      if (!registro[spec.columna]) continue;
      const campo = spec.campo(registro);
      if (variableDeCampo(campo) !== variable) continue;
      const texto = descifrarCon(llaveAnterior, campo, registro[spec.columna]);
      await tx[spec.modelo].update({ where: { id: registro.id }, data: { [spec.columna]: cifrarCon(llaveNueva, campo, texto) } });
      filas += 1;
    }
  }
  return filas;
}

async function recalcularIndiceRut({ llaveAnterior, llaveNueva }, tx) {
  const pacientes = await tx.paciente.findMany({ select: { id: true, rutCifrado: true, rutIndice: true } });
  for (const p of pacientes) {
    const rut = normalizarRut(descifrar('paciente.rut', p.rutCifrado));
    // Comprueba que el índice actual sea el de la llave anterior: una llave
    // anterior equivocada detiene la rotación antes de escribir nada malo.
    if (!hmacCon(llaveAnterior, rut).equals(Buffer.from(p.rutIndice))) throw new Error('La llave anterior no corresponde al índice del RUT');
    await tx.paciente.update({ where: { id: p.id }, data: { rutIndice: hmacCon(llaveNueva, rut) } });
  }
  return pacientes.length;
}

/**
 * Recifra (o recalcula, para el índice del RUT) todo lo que protege una
 * llave. Si cualquier fila falla, no queda nada a medias: todo va en una
 * transacción.
 *
 * @param {string} variable - una de ROTABLES.
 * @param {{llaveAnterior: Buffer, llaveNueva: Buffer}} llaves
 * @param {object} [client] - una transacción en curso; sin ella abre la suya.
 * @returns {Promise<{filas: number}>} filas reescritas.
 * @throws {Error} si las llaves son iguales o inválidas, si la variable no
 *   guarda datos rotables, o si la llave anterior no descifra algún valor.
 *
 * Consumidores: src/rotar-llaves.js (npm run llaves:rotar).
 */
async function rotar(variable, { llaveAnterior, llaveNueva }, client) {
  if (SIN_DATOS_ROTABLES.includes(variable)) throw new Error(`${variable} no guarda datos rotables en la base`);
  if (!ROTABLES.includes(variable)) throw new Error(`Variable desconocida: ${variable}`);
  validarLlave(llaveAnterior, 'La llave anterior');
  validarLlave(llaveNueva, 'La llave nueva');
  if (llaveAnterior.equals(llaveNueva)) throw new Error('La llave nueva y la anterior deben ser distintas');

  const ejecutar = async (tx) => {
    const filas = variable === 'PACIENTE_RUT_HMAC_KEY'
      ? await recalcularIndiceRut({ llaveAnterior, llaveNueva }, tx)
      : await recifrarColumnas(variable, { llaveAnterior, llaveNueva }, tx);
    await registrar({ actor: 'sistema', accion: 'ROTAR_LLAVE', entidad: 'Sistema', entidadId: 0, detalle: { variable, filas } }, tx);
    return { filas };
  };
  return client ? ejecutar(client) : prisma.$transaction(ejecutar, { timeout: 10 * 60 * 1000 });
}

module.exports = { rotar, ROTABLES };
