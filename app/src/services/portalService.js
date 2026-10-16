const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { logger } = require('../lib/logger');
const { descifrar, indiceCiego } = require('../lib/cifrado');
const { normalizarRut, rutValido } = require('../lib/rut');
const { enmascararContacto } = require('../lib/contacto');
const canalEnvio = require('../lib/canalEnvio');
const { registrar } = require('./auditService');
const pacienteService = require('./pacienteService');
const consentimientoService = require('./consentimientoService');
const derechosService = require('./derechosService');
const { METODOS, MINUTOS_CODIGO, nuevoCodigo, contactoEstable, consumirCodigo } = require('./verificacionService');

// Portal temporal del titular (clase PR 004: "Descargar mis datos", corregir,
// oponerse y revocar sin depender de un funcionario). No hay cuentas de
// pacientes: el titular ingresa con su RUT y un código de un solo uso enviado
// al contacto que ya tenía registrado, y recibe una sesión de 15 minutos
// atada a su propio registro.
//
// Amenazas y controles:
//   - Suplantación: el RUT no es secreto; lo que prueba la identidad es
//     recibir el código en el contacto registrado. Solo se envía a un
//     contacto que lleva 24 horas sin cambiar, vence a los 10 minutos y
//     admite 5 intentos (verificacionService.consumirCodigo).
//   - Enumeración: pedir el código responde siempre lo mismo, exista o no el
//     RUT, tenga o no contacto (la diferencia queda solo en la sesión).
//   - IDOR: ninguna ruta del portal recibe un id; el paciente sale siempre
//     de la sesión.
//   - Abuso del canal: a lo más 3 códigos por paciente por hora (además del
//     límite por IP de la ruta), para no inundar su teléfono o correo.
//   - Lo irreversible (supresión y bloqueo) se puede pedir, pero queda
//     pendiente de la cédula en admisión, igual que por teléfono.
//   - Un paciente bloqueado no entra: sus datos no se usan para nada, ni
//     para enviarle un código. Ejerce sus derechos a través de privacidad.

const MINUTOS_SESION = 15;
const ENVIOS_POR_HORA = 3;

/**
 * Pide el ingreso al portal: si el RUT es de un paciente con un contacto
 * registrado y estable, le envía un código. La respuesta al navegador es la
 * misma en todos los casos; lo que devuelve esta función queda solo en la
 * sesión.
 *
 * @param {string} rut - lo que escribió la persona.
 * @returns {Promise<{verificacionId: (number|null)}>} null si no se envió
 *   nada (RUT inexistente, sin contacto, contacto reciente, tope de envíos
 *   o sin canal de envío).
 * @throws {AppError} 400 si el RUT no tiene un formato válido (no revela si
 *   existe).
 *
 * Consumidores: routes/portal.js.
 */
async function solicitarIngreso(rut) {
  if (typeof rut !== 'string' || rut.length > 15 || !rutValido(rut)) throw new AppError('Revisa el RUT: el dígito verificador no corresponde', 400);
  const paciente = await prisma.paciente.findFirst({
    where: { rutIndice: indiceCiego('paciente.rut', normalizarRut(rut)), bloqueado: false },
    select: { id: true, contactoCifrado: true, createdAt: true },
  });
  if (!paciente || !paciente.contactoCifrado || !(await contactoEstable(paciente.id, paciente.createdAt))) return { verificacionId: null };

  const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000);
  const recientes = await prisma.verificacionIdentidad.count({ where: { pacienteId: paciente.id, metodo: METODOS.PORTAL, creadaEl: { gte: haceUnaHora } } });
  if (recientes >= ENVIOS_POR_HORA) {
    await registrar({ actor: 'portal', accion: 'PORTAL_CODIGO', entidad: 'Paciente', entidadId: paciente.id, resultado: 'denegado', detalle: { motivo: 'tope_de_envios' } });
    return { verificacionId: null };
  }

  // Un código nuevo invalida los anteriores del portal para este paciente.
  await prisma.verificacionIdentidad.updateMany({
    where: { pacienteId: paciente.id, metodo: METODOS.PORTAL, verificadaEl: null, expiraEl: { gt: new Date() } },
    data: { expiraEl: new Date() },
  });
  const { codigo, ...columnas } = nuevoCodigo();
  const fila = await prisma.verificacionIdentidad.create({ data: { pacienteId: paciente.id, metodo: METODOS.PORTAL, verificadaPorId: null, ...columnas } });

  const contacto = descifrar('paciente.contacto', paciente.contactoCifrado);
  try {
    await canalEnvio.enviar(
      contacto,
      `MediBox: su código para ingresar al portal del paciente es ${codigo}. Vence en ${MINUTOS_CODIGO} minutos. Es solo para que usted ingrese: no se lo dé a nadie, ni a un funcionario. Si no lo pidió, ignore este mensaje.`,
    );
  } catch (err) {
    await prisma.verificacionIdentidad.update({ where: { id: fila.id }, data: { expiraEl: new Date() } });
    // Solo el código del error: el mensaje de un servidor SMTP puede traer la
    // dirección del destinatario, y el log no lleva datos personales.
    logger.warn({ codigo: err.code || 'sin_canal', pacienteId: paciente.id }, 'Portal: no se pudo enviar el código');
    return { verificacionId: null };
  }
  await registrar({ actor: 'portal', accion: 'PORTAL_CODIGO', entidad: 'Paciente', entidadId: paciente.id });
  return { verificacionId: fila.id };
}

/**
 * Confirma el código del portal. Si es correcto, devuelve lo que se guarda
 * en la sesión del titular.
 *
 * @param {(number|null)} verificacionId - el de la sesión (null si no se envió nada).
 * @param {string} codigo - lo que escribió la persona.
 * @returns {Promise<{pacienteId: number, verificacionId: number, expiraEl: number}>}
 *   expiraEl en milisegundos: la sesión del portal dura 15 minutos, sin renovarse.
 * @throws {AppError} 400 si el código es incorrecto, vencido, ya usado o
 *   se agotaron los intentos (el mismo mensaje en todos los casos).
 *
 * Consumidores: routes/portal.js.
 */
async function confirmarIngreso(verificacionId, codigo) {
  const fila = verificacionId
    ? await prisma.verificacionIdentidad.findFirst({ where: { id: verificacionId, metodo: METODOS.PORTAL, verificadaEl: null } })
    : null;
  const correcto = await consumirCodigo(fila, codigo);
  if (!correcto || (await pacienteService.estaBloqueado(fila.pacienteId))) {
    if (fila) {
      await registrar({ actor: 'portal', accion: 'VERIFICAR_IDENTIDAD', entidad: 'Paciente', entidadId: fila.pacienteId, resultado: 'fallido', detalle: { metodo: METODOS.PORTAL } });
    }
    throw new AppError('Código incorrecto o vencido', 400);
  }
  await registrar({ actor: 'titular', accion: 'PORTAL_INGRESO', entidad: 'Paciente', entidadId: fila.pacienteId, detalle: { metodo: METODOS.PORTAL } });
  return { pacienteId: fila.pacienteId, verificacionId: fila.id, expiraEl: Date.now() + MINUTOS_SESION * 60 * 1000 };
}

/**
 * Comprueba la sesión del portal en cada petición: vigente y de un paciente
 * que no se bloqueó mientras tanto.
 *
 * @param {(object|undefined)} sesion - req.session.portal.
 * @returns {Promise<({pacienteId: number, verificacionId: number, expiraEl: number}|null)>}
 *
 * Consumidores: routes/portal.js (requirePortal).
 */
async function sesionVigente(sesion) {
  if (!sesion || !Number.isInteger(sesion.pacienteId) || !(sesion.expiraEl > Date.now())) return null;
  if (await pacienteService.estaBloqueado(sesion.pacienteId)) return null;
  return sesion;
}

/**
 * Lo que ve el titular en el portal: el mismo contenido que su archivo, más
 * lo necesario para los formularios (textos vigentes, si es menor de 14).
 * Queda en la auditoría como una lectura del propio titular.
 *
 * @param {{pacienteId: number}} titular - la sesión del portal.
 * @returns {Promise<object>}
 *
 * Consumidores: routes/portal.js.
 */
async function misDatos({ pacienteId }) {
  const [archivo, consentimientos, solicitudes, edad] = await Promise.all([
    derechosService.armarArchivoTitular(pacienteId),
    consentimientoService.estadoPorPaciente(pacienteId),
    derechosService.listarPorPaciente(pacienteId),
    pacienteService.edadDe(pacienteId),
  ]);
  await registrar({ actor: 'titular', accion: 'READ', entidad: 'Paciente', entidadId: pacienteId, detalle: { motivo: 'portal' } });
  return {
    ...archivo,
    contactoEnmascarado: archivo.titular.contacto ? enmascararContacto(archivo.titular.contacto) : null,
    estadoConsentimientos: consentimientos.map((c) => ({ finalidad: c.finalidad, estado: c.estado, textoVigente: c.textoVigente, otorgadoEl: c.otorgadoEl, revocadoEl: c.revocadoEl })),
    solicitudesAbiertas: solicitudes.filter((s) => s.estado === 'recibida' || s.estado === 'verificada'),
    requiereRepresentante: consentimientoService.requiereRepresentante(edad),
  };
}

/**
 * Descarga del archivo con todos sus datos (acceso y portabilidad).
 *
 * @param {{pacienteId: number, verificacionId: number}} titular
 * @returns {Promise<object>}
 *
 * Consumidores: routes/portal.js.
 */
function descargar({ pacienteId, verificacionId }) {
  return derechosService.exportarDesdePortal(pacienteId, verificacionId);
}

/**
 * Otorga un consentimiento desde el portal, sobre el texto vigente que el
 * titular leyó y aceptó (casilla sin marcar por defecto).
 *
 * @param {{pacienteId: number, verificacionId: number}} titular
 * @param {{finalidadClave: string, textoId: (number|string), acepto: string,
 *   representante?: object}} datos
 * @returns {Promise<{id: number}>}
 * @throws {AppError} 400 sin la casilla, con un texto no vigente o sin
 *   representante para un menor de 14; 409 si ya está vigente.
 *
 * Consumidores: routes/portal.js.
 */
function otorgar({ pacienteId, verificacionId }, { finalidadClave, textoId, acepto, representante }) {
  if (acepto !== 'si') throw new AppError('Marque la casilla para aceptar el texto: sin ella no se registra nada', 400);
  return consentimientoService.registrarOtorgamiento(
    { pacienteId, finalidadClave: String(finalidadClave || ''), textoId, canal: derechosService.CANAL_PORTAL, representante },
    { usuarioId: null, verificacionId, actor: 'titular' },
  );
}

/**
 * Revoca (u opone a) una finalidad desde el portal: un clic, igual que otorgar.
 *
 * @param {{pacienteId: number, verificacionId: number}} titular
 * @param {string} finalidadClave
 * @returns {Promise<number>} cuántos otorgamientos se cerraron (0 si no había uno abierto).
 *
 * Consumidores: routes/portal.js.
 */
function revocar({ pacienteId, verificacionId }, finalidadClave) {
  // Sin finalidad, revocarAbiertos cerraría todas: aquí siempre es una.
  if (typeof finalidadClave !== 'string' || !finalidadClave) throw new AppError('Elija el uso que quiere revocar', 400);
  return consentimientoService.revocarAbiertos(pacienteId, {
    finalidadClave,
    canal: derechosService.CANAL_PORTAL,
    usuarioId: null,
    verificacionId,
    actor: 'titular',
  });
}

/**
 * Presenta una solicitud de rectificación, supresión o bloqueo.
 *
 * @param {{pacienteId: number, verificacionId: number}} titular
 * @param {object} cuerpo - ver derechosService.registrarDesdePortal.
 * @returns {Promise<{id: number, venceEl: Date, pendienteDeCedula: boolean}>}
 *
 * Consumidores: routes/portal.js.
 */
function registrarSolicitud({ pacienteId, verificacionId }, cuerpo) {
  return derechosService.registrarDesdePortal(pacienteId, cuerpo, verificacionId);
}

module.exports = { MINUTOS_SESION, ENVIOS_POR_HORA, solicitarIngreso, confirmarIngreso, sesionVigente, misDatos, descargar, otorgar, revocar, registrarSolicitud };
