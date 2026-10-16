const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { enmascararContacto } = require('../lib/contacto');
const canalEnvio = require('../lib/canalEnvio');
const { registrar } = require('./auditService');
const pacienteService = require('./pacienteService');

// Verificación de identidad del titular antes de cambiar un consentimiento o
// de ejecutar un derecho. Dos métodos:
//   - CEDULA: el funcionario vio la cédula en admisión. Es la base.
//   - CODIGO: un código de un solo uso enviado al contacto que el paciente
//     ya tenía registrado, que el titular le dicta al funcionario.
// Qué método acepta cada petición lo decide quien llama (consentimiento y
// derechos), con exigirVerificacion().
const METODOS = { CEDULA: 'cedula_presencial', CODIGO: 'codigo_contacto' };
const NOMBRES_METODO = { [METODOS.CEDULA]: 'cédula en admisión', [METODOS.CODIGO]: 'código al contacto registrado' };

const DIGITOS_CODIGO = 6;
const MINUTOS_CODIGO = 10;
const INTENTOS_MAXIMOS = 5;
const VIGENCIA_VERIFICACION_MIN = 15;
// El código solo va a un contacto que no cambió en las últimas 24 horas: así
// no sirve que quien llama entregue un número nuevo y se lo registren.
const HORAS_CONTACTO_ESTABLE = 24;

const minutosAntes = (minutos) => new Date(Date.now() - minutos * 60 * 1000);

function hashCodigo(sal, codigo) {
  return crypto.createHash('sha256').update(sal).update(codigo, 'utf8').digest();
}

/**
 * Registra que el funcionario vio en persona la cédula del titular.
 *
 * @param {number} pacienteId
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {Promise<{verificacionId: number}>}
 * @throws {AppError} 404 si el paciente no existe o está fuera de su alcance.
 *
 * Consumidores: routes/verificacion.js.
 */
async function verificarConCedula(pacienteId, solicitante) {
  await pacienteService.exigirAlcance(pacienteId, solicitante);
  const fila = await prisma.verificacionIdentidad.create({
    data: { pacienteId, metodo: METODOS.CEDULA, verificadaPorId: solicitante.id, verificadaEl: new Date() },
  });
  await registrar({ usuarioId: solicitante.id, accion: 'VERIFICAR_IDENTIDAD', entidad: 'Paciente', entidadId: pacienteId, detalle: { metodo: METODOS.CEDULA } });
  return { verificacionId: fila.id };
}

/**
 * Envía un código de un solo uso al contacto registrado del paciente. Del
 * código solo se guarda su hash; nunca va a la respuesta, al log ni a la
 * auditoría.
 *
 * @param {number} pacienteId
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @param {{desde?: Date}} [opciones] - recepción de la solicitud: el contacto
 *   no puede haber cambiado después de ella.
 * @returns {Promise<{contactoEnmascarado: string, expiraEl: Date}>}
 * @throws {AppError} 409 si no hay contacto, si cambió recientemente o si no
 *   hay un canal de envío; 404 si el paciente está fuera de su alcance.
 *
 * Consumidores: routes/verificacion.js, derechosService.
 */
async function enviarCodigo(pacienteId, solicitante, { desde } = {}) {
  const { contacto, createdAt } = await pacienteService.contactoParaVerificacion(pacienteId, solicitante);
  if (!contacto) {
    throw new AppError('El paciente no tiene un contacto registrado: verifica con su cédula en la próxima visita', 409);
  }
  const registradoEl = (await pacienteService.ultimoCambioDe(pacienteId, 'contacto')) || createdAt;
  if (registradoEl > minutosAntes(HORAS_CONTACTO_ESTABLE * 60) || (desde && registradoEl >= desde)) {
    throw new AppError('El contacto cambió recientemente: el código solo se envía a un contacto registrado antes de la petición', 409);
  }

  // Un código nuevo invalida los pendientes del mismo paciente y funcionario.
  await prisma.verificacionIdentidad.updateMany({
    where: { pacienteId, verificadaPorId: solicitante.id, metodo: METODOS.CODIGO, verificadaEl: null, expiraEl: { gt: new Date() } },
    data: { expiraEl: new Date() },
  });

  const codigo = String(crypto.randomInt(10 ** DIGITOS_CODIGO)).padStart(DIGITOS_CODIGO, '0');
  const sal = crypto.randomBytes(16);
  const expiraEl = new Date(Date.now() + MINUTOS_CODIGO * 60 * 1000);
  const fila = await prisma.verificacionIdentidad.create({
    data: { pacienteId, metodo: METODOS.CODIGO, verificadaPorId: solicitante.id, codigoHash: hashCodigo(sal, codigo), sal, expiraEl },
  });

  try {
    canalEnvio.enviar(contacto, `Su código de verificación de MediBox es ${codigo}. Dígaselo solo al funcionario que lo atiende. Vence en ${MINUTOS_CODIGO} minutos.`);
  } catch {
    await prisma.verificacionIdentidad.update({ where: { id: fila.id }, data: { expiraEl: new Date() } });
    throw new AppError('No hay un canal de envío configurado: verifica con la cédula del titular', 409);
  }

  await registrar({ usuarioId: solicitante.id, accion: 'VERIFICACION_ENVIADA', entidad: 'Paciente', entidadId: pacienteId });
  return { contactoEnmascarado: enmascararContacto(contacto), expiraEl };
}

/**
 * Confirma el código que el titular le dictó al funcionario. Es de un solo
 * uso, vence a los 10 minutos y admite hasta 5 intentos.
 *
 * @param {number} pacienteId
 * @param {string} codigo - lo que dictó el titular.
 * @param {{id: number}} solicitante - req.usuario.
 * @returns {Promise<{verificacionId: number}>}
 * @throws {AppError} 400 si el código es incorrecto, está vencido, ya se usó
 *   o se agotaron los intentos.
 *
 * Consumidores: routes/verificacion.js.
 */
async function confirmarCodigo(pacienteId, codigo, solicitante) {
  const fila = await prisma.verificacionIdentidad.findFirst({
    where: { pacienteId, verificadaPorId: solicitante.id, metodo: METODOS.CODIGO, verificadaEl: null },
    orderBy: { id: 'desc' },
  });

  const usable = fila && fila.expiraEl > new Date() && fila.intentos < INTENTOS_MAXIMOS;
  const correcto = usable && crypto.timingSafeEqual(hashCodigo(fila.sal, String(codigo)), fila.codigoHash);

  if (!correcto) {
    if (usable) await prisma.verificacionIdentidad.update({ where: { id: fila.id }, data: { intentos: { increment: 1 } } });
    await registrar({ usuarioId: solicitante.id, accion: 'VERIFICAR_IDENTIDAD', entidad: 'Paciente', entidadId: pacienteId, resultado: 'fallido', detalle: { metodo: METODOS.CODIGO } });
    throw new AppError('Código incorrecto o vencido', 400);
  }

  await prisma.verificacionIdentidad.update({ where: { id: fila.id }, data: { verificadaEl: new Date() } });
  await registrar({ usuarioId: solicitante.id, accion: 'VERIFICAR_IDENTIDAD', entidad: 'Paciente', entidadId: pacienteId, detalle: { metodo: METODOS.CODIGO } });
  return { verificacionId: fila.id };
}

/**
 * Verificación vigente: confirmada por ESE funcionario, para ESE paciente,
 * con un método aceptado, hace menos de 15 minutos.
 *
 * @param {number} pacienteId
 * @param {number} usuarioId
 * @param {string[]} metodos - valores de METODOS.
 * @returns {Promise<({id: number, metodo: string}|null)>}
 *
 * Consumidores: exigirVerificacion(), vistas (estado de la verificación).
 */
async function verificacionVigente(pacienteId, usuarioId, metodos) {
  return prisma.verificacionIdentidad.findFirst({
    where: { pacienteId, verificadaPorId: usuarioId, metodo: { in: metodos }, verificadaEl: { gte: minutosAntes(VIGENCIA_VERIFICACION_MIN) } },
    orderBy: { verificadaEl: 'desc' },
    select: { id: true, metodo: true },
  });
}

/**
 * Exige una verificación vigente con alguno de los métodos aceptados.
 *
 * @param {number} pacienteId
 * @param {number} usuarioId
 * @param {string[]} metodos - valores de METODOS.
 * @returns {Promise<{id: number, metodo: string}>}
 * @throws {AppError} 403 si no la hay.
 *
 * Consumidores: consentimientoService, derechosService.
 */
async function exigirVerificacion(pacienteId, usuarioId, metodos) {
  const vigente = await verificacionVigente(pacienteId, usuarioId, metodos);
  if (!vigente) {
    throw new AppError(`Verifica primero la identidad del titular (${metodos.map((m) => NOMBRES_METODO[m]).join(' o ')})`, 403);
  }
  return vigente;
}

module.exports = {
  METODOS,
  NOMBRES_METODO,
  VIGENCIA_VERIFICACION_MIN,
  verificarConCedula,
  enviarCodigo,
  confirmarCodigo,
  verificacionVigente,
  exigirVerificacion,
};
