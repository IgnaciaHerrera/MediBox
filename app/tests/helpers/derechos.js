const { prisma } = require('../../src/lib/prisma');
const canalEnvio = require('../../src/lib/canalEnvio');
const verificacion = require('../../src/services/verificacionService');
const derechos = require('../../src/services/derechosService');

/**
 * Registra una solicitud como lo haría el operador y, si se pide, la deja
 * verificada con el método indicado.
 *
 * @param {object} paciente - fila de pacientes.
 * @param {{id: number}} operador - usuario operador.
 * @param {object} datos - derecho, canal y lo que pida el derecho.
 * @param {{metodo?: ('cedula'|'codigo'), contacto?: string}} [opciones]
 * @returns {Promise<object>} la solicitud.
 */
async function solicitudDePrueba(paciente, operador, datos, { metodo, contacto } = {}) {
  const solicitante = { id: operador.id, permisos: ['paciente.read', 'derechos.registrar'] };
  const { id } = await derechos.registrarSolicitud({ pacienteId: paciente.id, canal: 'presencial', ...datos }, solicitante);
  if (metodo === 'cedula') await verificacion.verificarConCedula(paciente.id, solicitante);
  if (metodo === 'codigo') {
    await verificacion.enviarCodigo(paciente.id, solicitante);
    const codigo = canalEnvio.ultimo(contacto).mensaje.match(/\b(\d{6})\b/)[1];
    await verificacion.confirmarCodigo(paciente.id, codigo, solicitante);
  }
  if (metodo) await derechos.verificarSolicitud(id, solicitante);
  return prisma.solicitudDerecho.findUniqueOrThrow({ where: { id } });
}

/**
 * Borra lo que un test creó alrededor de sus pacientes, en el orden que
 * exigen las claves foráneas. La auditoría no se toca (solo inserción).
 *
 * @param {number[]} pacienteIds
 */
async function limpiarPacientes(pacienteIds) {
  const where = { pacienteId: { in: pacienteIds } };
  await prisma.historialCambio.deleteMany({ where });
  await prisma.consentimiento.deleteMany({ where });
  await prisma.solicitudDerecho.deleteMany({ where });
  await prisma.verificacionIdentidad.deleteMany({ where });
  await prisma.cita.deleteMany({ where });
  await prisma.paciente.deleteMany({ where: { id: { in: pacienteIds } } });
}

module.exports = { solicitudDePrueba, limpiarPacientes };
