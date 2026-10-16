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
//   - PORTAL: el mismo código, pero lo ingresa el propio titular en el portal
//     (portalService); no hay funcionario que verifique.
// Qué método acepta cada petición lo decide quien llama (consentimiento y
// derechos), con exigirVerificacion().
const METODOS = { CEDULA: 'cedula_presencial', CODIGO: 'codigo_contacto', PORTAL: 'codigo_portal' };
const NOMBRES_METODO = {
  [METODOS.CEDULA]: 'cédula en admisión',
  [METODOS.CODIGO]: 'código al contacto registrado',
  [METODOS.PORTAL]: 'código ingresado por el titular en el portal',
};

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
 * Genera un código de un solo uso y las columnas que se guardan de él (nunca
 * el código mismo).
 *
 * @returns {{codigo: string, codigoHash: Buffer, sal: Buffer, expiraEl: Date}}
 *
 * Consumidores: enviarCodigo(), portalService.solicitarIngreso.
 */
function nuevoCodigo() {
  const codigo = String(crypto.randomInt(10 ** DIGITOS_CODIGO)).padStart(DIGITOS_CODIGO, '0');
  const sal = crypto.randomBytes(16);
  return { codigo, codigoHash: hashCodigo(sal, codigo), sal, expiraEl: new Date(Date.now() + MINUTOS_CODIGO * 60 * 1000) };
}

/**
 * Si el contacto del paciente lleva al menos 24 horas sin cambiar (y no
 * cambió después de `desde`): solo a un contacto así se envía un código.
 *
 * @param {number} pacienteId
 * @param {Date} creadoEl - alta del paciente, si el contacto nunca cambió.
 * @param {Date} [desde] - recepción de la solicitud.
 * @returns {Promise<boolean>}
 *
 * Consumidores: enviarCodigo(), portalService.solicitarIngreso.
 */
async function contactoEstable(pacienteId, creadoEl, desde) {
  const registradoEl = (await pacienteService.ultimoCambioDe(pacienteId, 'contacto')) || creadoEl;
  return registradoEl <= minutosAntes(HORAS_CONTACTO_ESTABLE * 60) && !(desde && registradoEl >= desde);
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
  if (!(await contactoEstable(pacienteId, createdAt, desde))) {
    throw new AppError('El contacto cambió recientemente: el código solo se envía a un contacto registrado antes de la petición', 409);
  }

  // Un código nuevo invalida los pendientes del mismo paciente y funcionario.
  await prisma.verificacionIdentidad.updateMany({
    where: { pacienteId, verificadaPorId: solicitante.id, metodo: METODOS.CODIGO, verificadaEl: null, expiraEl: { gt: new Date() } },
    data: { expiraEl: new Date() },
  });

  const { codigo, ...columnas } = nuevoCodigo();
  const fila = await prisma.verificacionIdentidad.create({
    data: { pacienteId, metodo: METODOS.CODIGO, verificadaPorId: solicitante.id, ...columnas },
  });
  const { expiraEl } = columnas;

  try {
    await canalEnvio.enviar(contacto, `Su código de verificación de MediBox es ${codigo}. Dígaselo solo al funcionario que lo atiende. Vence en ${MINUTOS_CODIGO} minutos.`);
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

  if (!(await consumirCodigo(fila, codigo))) {
    await registrar({ usuarioId: solicitante.id, accion: 'VERIFICAR_IDENTIDAD', entidad: 'Paciente', entidadId: pacienteId, resultado: 'fallido', detalle: { metodo: METODOS.CODIGO } });
    throw new AppError('Código incorrecto o vencido', 400);
  }
  await registrar({ usuarioId: solicitante.id, accion: 'VERIFICAR_IDENTIDAD', entidad: 'Paciente', entidadId: pacienteId, detalle: { metodo: METODOS.CODIGO } });
  return { verificacionId: fila.id };
}

/**
 * Prueba un código contra su fila pendiente y, si es correcto, la marca
 * verificada. Las dos escrituras son condicionales en la base: cada intento
 * reserva uno de los 5 antes de comparar, así que intentos simultáneos no
 * superan el tope, y solo uno de dos usos simultáneos del código correcto lo
 * consume.
 *
 * @param {(object|null)} fila - fila de verificaciones_identidad pendiente.
 * @param {string} codigo - lo que ingresó la persona.
 * @returns {Promise<boolean>} true solo si el código era correcto y quedó usado.
 *
 * Consumidores: confirmarCodigo(), portalService.confirmarIngreso.
 */
async function consumirCodigo(fila, codigo) {
  if (!fila || !fila.codigoHash || fila.expiraEl <= new Date()) return false;
  const { count: reservado } = await prisma.verificacionIdentidad.updateMany({
    where: { id: fila.id, verificadaEl: null, intentos: { lt: INTENTOS_MAXIMOS } },
    data: { intentos: { increment: 1 } },
  });
  if (reservado !== 1 || !crypto.timingSafeEqual(hashCodigo(fila.sal, String(codigo)), fila.codigoHash)) return false;
  const { count: usado } = await prisma.verificacionIdentidad.updateMany({
    where: { id: fila.id, verificadaEl: null, expiraEl: { gt: new Date() } },
    data: { verificadaEl: new Date() },
  });
  return usado === 1;
}

/**
 * Verificación vigente: confirmada por ESE funcionario, para ESE paciente,
 * con un método aceptado, hace menos de 15 minutos.
 *
 * @param {number} pacienteId
 * @param {number} usuarioId
 * @param {string[]} metodos - valores de METODOS.
 * @returns {Promise<({id: number, metodo: string, verificadaEl: Date}|null)>}
 *
 * Consumidores: exigirVerificacion(), estadoParaVista().
 */
async function verificacionVigente(pacienteId, usuarioId, metodos) {
  return prisma.verificacionIdentidad.findFirst({
    where: { pacienteId, verificadaPorId: usuarioId, metodo: { in: metodos }, verificadaEl: { gte: minutosAntes(VIGENCIA_VERIFICACION_MIN) } },
    orderBy: { verificadaEl: 'desc' },
    select: { id: true, metodo: true, verificadaEl: true },
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

/**
 * Lo que muestra el parcial de verificación: si hay una vigente, con qué
 * método y hasta cuándo, y a qué contacto (enmascarado) iría el código.
 *
 * @param {number} pacienteId
 * @param {number} usuarioId
 * @param {(string|null)} contacto - el contacto en claro que ya tiene la ficha.
 * @returns {Promise<{vigente: ({metodo: string, nombreMetodo: string, hasta: Date}|null),
 *   contactoEnmascarado: (string|null)}>}
 *
 * Consumidores: pacienteViewController.detalle, solicitudViewController.
 */
async function estadoParaVista(pacienteId, usuarioId, contacto) {
  const vigente = await verificacionVigente(pacienteId, usuarioId, Object.values(METODOS));
  return {
    vigente: vigente
      ? { metodo: vigente.metodo, nombreMetodo: NOMBRES_METODO[vigente.metodo], hasta: new Date(vigente.verificadaEl.getTime() + VIGENCIA_VERIFICACION_MIN * 60 * 1000) }
      : null,
    contactoEnmascarado: contacto ? enmascararContacto(contacto) : null,
  };
}

module.exports = {
  METODOS,
  estadoParaVista,
  NOMBRES_METODO,
  VIGENCIA_VERIFICACION_MIN,
  verificarConCedula,
  enviarCodigo,
  confirmarCodigo,
  consumirCodigo,
  nuevoCodigo,
  contactoEstable,
  MINUTOS_CODIGO,
  verificacionVigente,
  exigirVerificacion,
};
