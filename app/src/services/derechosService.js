const Joi = require('joi');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { cifrar, descifrar } = require('../lib/cifrado');
const { TRATAMIENTO } = require('../lib/tratamiento');
const { ETIQUETAS } = require('../lib/archivoTitular');
const { normalizarRut, rutValido } = require('../lib/rut');
const { logger } = require('../lib/logger');
const { registrar } = require('./auditService');
const pacienteService = require('./pacienteService');
const citaService = require('./citaService');
const consentimientoService = require('./consentimientoService');
const { registrarSupresion } = require('./supresionService');
const { METODOS, exigirVerificacion } = require('./verificacionService');
const { crearNotificacion } = require('./notificacionService');
const canalEnvio = require('../lib/canalEnvio');
const { isoLocal, fechaDMA } = require('../lib/fecha');

// Derechos del titular (ARCO+, Hito 3). Los cinco pasos de la clase:
//   1. Recepción: un funcionario registra la solicitud, por el canal por el
//      que llegó, sin costo y sin exigir todavía la verificación.
//   2. Verificación de identidad, con el método que acepta cada derecho.
//   3. Registro: queda con su fecha, el derecho y su vencimiento.
//   4. Ejecución (rol privacidad), solo si la identidad está verificada.
//   5. Respuesta al titular, registrada y cifrada.

const DERECHOS = ['acceso', 'portabilidad', 'rectificacion', 'supresion', 'bloqueo', 'oposicion'];
// Canal de lo que el titular hace por sí mismo en el portal. No es una
// opción para el personal: solo lo asigna el servidor.
const CANAL_PORTAL = 'portal';

// Plazos de respuesta de la Ley 21.719, art. 11 (rige desde el 01/12/2026):
// 30 días corridos desde el ingreso, prorrogables una sola vez hasta por 30
// días más; el bloqueo temporal se responde dentro de 2 días hábiles.
const PLAZO_RESPUESTA_DIAS = 30;
const PRORROGA_MAXIMA_DIAS = 30;
const PLAZO_BLOQUEO_DIAS_HABILES = 2;
// Cuándo avisar a privacidad que una solicitud está por vencer.
const AVISO_VENCIMIENTO_DIAS = 3;
// Lo que la ley exige decirle al titular en una denegación total o parcial
// (art. 11): que puede reclamar ante la Agencia.
const AVISO_RECLAMO =
  'Si no está de acuerdo con esta respuesta, puede reclamar ante la Agencia de Protección de Datos Personales dentro de 30 días hábiles (Ley 21.719, art. 11).';

// Qué método de verificación acepta cada derecho: una sola fuente para la
// vista (qué ofrecer) y el servicio (qué aceptar). La supresión y el bloqueo
// son irreversibles: solo con la cédula vista en persona.
// El código ingresado en el portal vale lo mismo que el dictado al
// funcionario: llega al mismo contacto registrado.
const METODOS_POR_DERECHO = {
  acceso: [METODOS.CEDULA, METODOS.CODIGO, METODOS.PORTAL],
  portabilidad: [METODOS.CEDULA, METODOS.CODIGO, METODOS.PORTAL],
  rectificacion: [METODOS.CEDULA, METODOS.CODIGO, METODOS.PORTAL],
  oposicion: [METODOS.CEDULA, METODOS.CODIGO, METODOS.PORTAL],
  supresion: [METODOS.CEDULA],
  bloqueo: [METODOS.CEDULA],
};

// Quien presenta una solicitud a nombre del titular: su representante legal
// (un menor de 14) o un apoderado con poder notarial (el mandatario de la
// Ley 21.719, art. 11 letra a).
const RELACIONES_SOLICITUD = [...consentimientoService.RELACIONES, 'apoderado'];

// Formato de cada valor que puede proponer una rectificación, igual que al
// registrar o editar un paciente.
const VALOR_POR_CAMPO = {
  nombre: Joi.string().trim().min(2).max(150),
  rut: Joi.string()
    .max(12)
    .custom((valor, helpers) => (rutValido(valor) ? normalizarRut(valor) : helpers.message('El RUT propuesto no es válido: revisa el dígito verificador'))),
  fechaNacimiento: Joi.date().iso().max('now').custom((valor) => valor.toISOString().slice(0, 10)),
  contacto: Joi.string().trim().min(5).max(100),
};

const solicitudSchema = Joi.object({
  derecho: Joi.string().valid(...DERECHOS).required().messages({ 'any.only': 'Elige el derecho que se ejerce', 'any.required': 'Elige el derecho que se ejerce' }),
  canal: Joi.string().valid(...consentimientoService.CANALES).required().messages({ 'any.only': 'Indica por qué canal llegó la solicitud', 'any.required': 'Indica por qué canal llegó la solicitud' }),
  campo: Joi.when('derecho', { is: 'rectificacion', then: Joi.string().valid(...Object.keys(VALOR_POR_CAMPO)).required(), otherwise: Joi.any().strip() }).messages({
    'any.only': 'Elige el dato que se corrige',
    'any.required': 'Elige el dato que se corrige',
  }),
  valorPropuesto: Joi.when('derecho', { is: 'rectificacion', then: Joi.string().trim().required(), otherwise: Joi.any().strip() }).messages({
    'any.required': 'Indica el valor correcto',
    'string.empty': 'Indica el valor correcto',
  }),
  finalidadClave: Joi.when('derecho', { is: 'oposicion', then: Joi.string().required(), otherwise: Joi.any().strip() }).messages({
    'any.required': 'Indica a qué uso se opone',
  }),
  solicitanteEsRepresentante: Joi.boolean().truthy('si').falsy('').default(false),
  solicitanteRelacion: Joi.string().valid(...RELACIONES_SOLICITUD).empty(''),
  solicitanteAcreditacion: Joi.string().valid(...consentimientoService.DOCUMENTOS_REPRESENTACION, consentimientoService.DECLARADA).empty(''),
});

// Verificación doble de un representante: su identidad y la representación.
// Lo irreversible, o lo que pide un apoderado de un adulto (que no recibe el
// código del titular), solo se ejecuta con la representación acreditada con
// un documento; para lo demás basta con declararla, porque la verificación
// del código llega igual al contacto registrado del titular.
function exigeDocumento(solicitud) {
  return solicitud.solicitanteEsRepresentante && (IRREVERSIBLES.includes(solicitud.derecho) || solicitud.solicitanteRelacion === 'apoderado');
}

// Lo exige y todavía no la acreditó con un documento.
function faltaAcreditar(solicitud) {
  return exigeDocumento(solicitud) && [null, consentimientoService.DECLARADA].includes(solicitud.solicitanteAcreditacion);
}

function sumarDias(fecha, dias) {
  return new Date(fecha.getTime() + dias * 24 * 60 * 60 * 1000);
}

// ponytail: solo salta sábados y domingos, no los feriados; agregar una
// tabla de feriados si un bloqueo pedido en víspera de feriado vence antes de lo debido.
function sumarDiasHabiles(fecha, dias) {
  let resultado = new Date(fecha);
  let restantes = dias;
  while (restantes > 0) {
    resultado = sumarDias(resultado, 1);
    if (resultado.getDay() !== 0 && resultado.getDay() !== 6) restantes -= 1;
  }
  return resultado;
}

/**
 * Fecha límite para responder una solicitud recibida en una fecha.
 *
 * @param {string} derecho
 * @param {Date} recibidaEl
 * @returns {Date} 2 días hábiles para el bloqueo; 30 días corridos para el resto.
 *
 * Consumidores: crearSolicitud(), exportarDesdePortal(); tests.
 */
function calcularVencimiento(derecho, recibidaEl) {
  return derecho === 'bloqueo' ? sumarDiasHabiles(recibidaEl, PLAZO_BLOQUEO_DIAS_HABILES) : sumarDias(recibidaEl, PLAZO_RESPUESTA_DIAS);
}


// Acuse de recibo (art. 11) al contacto que el titular ya tenía registrado,
// aunque la solicitud llegue por otro canal: si no la presentó él, se entera.
// Es un mejor esfuerzo: sin contacto, o si el envío falla, la solicitud sigue.
async function acusarRecibo(pacienteId, { id, derecho, recibidaEl, venceEl }) {
  const contacto = (await pacienteService.contactosParaProceso([pacienteId])).get(pacienteId);
  if (!contacto) return false;
  try {
    await canalEnvio.enviar(
      contacto,
      `MediBox recibió el ${fechaDMA(isoLocal(recibidaEl).slice(0, 10))} una solicitud de ${ETIQUETAS.derecho[derecho].toLowerCase()} de sus datos, con el número ${id}. Responderemos a más tardar el ${fechaDMA(isoLocal(venceEl).slice(0, 10))}. Si usted no la presentó, avise en admisión.`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Registra una solicitud de derechos (paso 1). Queda 'recibida' y sin
 * verificar: verificar es un paso aparte, y una solicitud que no se puede
 * verificar todavía queda pendiente hasta la próxima visita.
 *
 * @param {object} datos - pacienteId, derecho, canal y, según el derecho,
 *   campo y valorPropuesto (rectificación) o finalidadClave (oposición);
 *   solicitanteEsRepresentante y solicitanteRelacion.
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @param {{origenSolicitudId?: number}} [opciones] - para privacidad: el
 *   titular es el de esa solicitud anterior (también si está bloqueado).
 * @returns {Promise<{id: number, venceEl: Date, acuse: boolean}>} acuse: si se envió el
 *   acuse de recibo al contacto registrado.
 * @throws {AppError} 400 si faltan datos o son inválidos; 404 si el
 *   paciente está fuera de su alcance.
 *
 * Consumidores: pacienteViewController.registrarSolicitud,
 *   solicitudViewController.nueva.
 */
async function registrarSolicitud({ pacienteId: idPedido, ...cuerpo }, solicitante, { origenSolicitudId } = {}) {
  const { error, value } = solicitudSchema.validate(cuerpo, { stripUnknown: true });
  if (error) throw new AppError(error.details[0].message, 400);
  let pacienteId = idPedido;
  if (origenSolicitudId) {
    // Privacidad registra una solicitud nueva de un titular que ya conoce por
    // una anterior: así un paciente bloqueado, que el operador ya no ve,
    // puede seguir ejerciendo sus derechos.
    if (!solicitante.permisos.includes('derechos.gestionar')) throw new AppError('Permiso insuficiente', 403);
    pacienteId = (await solicitudOError(origenSolicitudId)).pacienteId;
  } else {
    await pacienteService.exigirAlcance(pacienteId, solicitante);
  }
  return crearSolicitud(pacienteId, value, { recibidaPorId: solicitante.id });
}

// Lo común a la recepción por un funcionario y por el portal: valida lo que
// pide cada derecho y crea la solicitud. Desde el portal llega ya verificada
// con el código, si el derecho acepta ese método.
async function crearSolicitud(pacienteId, value, { recibidaPorId, actor = 'usuario', verificacion = null }) {
  let valorPropuestoCifrado = null;
  if (value.derecho === 'rectificacion') {
    const { error: errorValor, value: valor } = VALOR_POR_CAMPO[value.campo].validate(value.valorPropuesto);
    if (errorValor) throw new AppError(errorValor.details[0].message, 400);
    valorPropuestoCifrado = cifrar(`solicitud.valor.${value.campo}`, valor);
  }
  if (value.derecho === 'oposicion' && !(await prisma.finalidad.findFirst({ where: { clave: value.finalidadClave, activa: true } }))) {
    throw new AppError('Solo es posible oponerse a un uso que requiere consentimiento', 400);
  }
  if (consentimientoService.requiereRepresentante(await pacienteService.edadDe(pacienteId))) {
    if (!value.solicitanteEsRepresentante || !value.solicitanteRelacion) {
      throw new AppError(`El titular es menor de ${consentimientoService.EDAD_CONSENTIMIENTO_PROPIO} años: la solicitud la presenta su representante (indica la relación)`, 400);
    }
  }
  let acreditacion = null;
  if (value.solicitanteEsRepresentante) {
    if (!value.solicitanteRelacion) throw new AppError('Indica la relación de quien presenta la solicitud con el titular', 400);
    // Por teléfono, por correo o en el portal no se puede ver un documento:
    // la representación queda declarada. En admisión se acredita.
    acreditacion = value.solicitanteAcreditacion || consentimientoService.DECLARADA;
    if (value.canal === 'presencial' && acreditacion === consentimientoService.DECLARADA) {
      throw new AppError('En admisión la representación se acredita con un documento: indica cuál viste', 400);
    }
    if (value.solicitanteRelacion === 'apoderado' && ![consentimientoService.DECLARADA, 'poder_notarial'].includes(acreditacion)) {
      throw new AppError('Un apoderado acredita su representación con un poder notarial', 400);
    }
  }

  const recibidaEl = new Date();
  const fila = await prisma.solicitudDerecho.create({
    data: {
      pacienteId,
      derecho: value.derecho,
      canal: value.canal,
      recibidaEl,
      venceEl: calcularVencimiento(value.derecho, recibidaEl),
      recibidaPorId,
      ...(verificacion
        ? { estado: 'verificada', identidadVerificada: true, metodoVerificacion: verificacion.metodo, verificacionId: verificacion.id, verificadaEl: recibidaEl }
        : {}),
      solicitanteEsRepresentante: value.solicitanteEsRepresentante,
      solicitanteRelacion: value.solicitanteEsRepresentante ? value.solicitanteRelacion || null : null,
      solicitanteAcreditacion: acreditacion,
      campo: value.campo || null,
      valorPropuestoCifrado,
      finalidadClave: value.finalidadClave || null,
    },
    select: { id: true, venceEl: true },
  });
  await registrar({
    usuarioId: recibidaPorId,
    actor,
    accion: 'SOLICITAR',
    entidad: 'Paciente',
    entidadId: pacienteId,
    detalle: { solicitudId: fila.id, derecho: value.derecho, canal: value.canal, ...(verificacion ? { metodo: verificacion.metodo } : {}) },
  });
  const acuse = await acusarRecibo(pacienteId, { ...fila, derecho: value.derecho, recibidaEl });
  return { ...fila, acuse };
}

// Lo que el titular puede pedir en el portal. El acceso y la portabilidad
// son la descarga directa del archivo, y la oposición es revocar el
// consentimiento: ninguno necesita una solicitud aparte.
const DERECHOS_PORTAL = ['rectificacion', 'supresion', 'bloqueo'];
const solicitudPortalSchema = solicitudSchema.keys({
  derecho: Joi.string().valid(...DERECHOS_PORTAL).required().messages({ 'any.only': 'Elige qué quiere pedir', 'any.required': 'Elige qué quiere pedir' }),
  canal: Joi.any().strip(),
  // En el portal nadie ve un documento: la representación queda declarada.
  solicitanteAcreditacion: Joi.any().strip(),
});

/**
 * Registra una solicitud que el titular presenta en el portal. Queda
 * verificada con su código si el derecho lo acepta (rectificación); la
 * supresión y el bloqueo quedan pendientes de la cédula en admisión.
 *
 * @param {number} pacienteId - el de la sesión del portal, nunca del cuerpo.
 * @param {object} cuerpo - derecho y, según el derecho, campo y valorPropuesto;
 *   solicitanteEsRepresentante y solicitanteRelacion para un menor de 14.
 * @param {number} verificacionId - el código con que ingresó.
 * @returns {Promise<{id: number, venceEl: Date, acuse: boolean, pendienteDeCedula: boolean}>}
 * @throws {AppError} 400 si faltan datos o son inválidos.
 *
 * Consumidores: portalService.registrarSolicitud.
 */
async function registrarDesdePortal(pacienteId, cuerpo, verificacionId) {
  const { error, value } = solicitudPortalSchema.validate(cuerpo, { stripUnknown: true });
  if (error) throw new AppError(error.details[0].message, 400);
  const pendienteDeCedula = !METODOS_POR_DERECHO[value.derecho].includes(METODOS.PORTAL);
  const fila = await crearSolicitud(
    pacienteId,
    { ...value, canal: CANAL_PORTAL },
    { recibidaPorId: null, actor: 'titular', verificacion: pendienteDeCedula ? null : { id: verificacionId, metodo: METODOS.PORTAL } },
  );
  return { ...fila, pendienteDeCedula };
}

/**
 * Adjunta a la solicitud la verificación de identidad vigente del
 * funcionario (paso 2), si su método es uno que acepta ese derecho. Un
 * código solo vale si el contacto no cambió después de recibir la solicitud.
 * Si la presentó un representante y lo que pide exige la representación
 * acreditada (faltaAcreditar), aquí se registra el documento que el
 * funcionario vio.
 *
 * @param {number} solicitudId
 * @param {{id: number}} solicitante - req.usuario.
 * @param {{pacienteId?: number, documento?: string}} [opciones] - pacienteId:
 *   el paciente de la ruta (la solicitud debe ser suya); documento: el que
 *   acredita la representación, si hace falta.
 * @returns {Promise<void>}
 * @throws {AppError} 403 sin una verificación aceptada; 409 si ya estaba
 *   verificada o cerrada, o si falta acreditar la representación; 404 si no
 *   existe o es de otro paciente.
 *
 * Consumidores: pacienteViewController.verificarSolicitud, solicitudViewController.
 */
async function verificarSolicitud(solicitudId, solicitante, { pacienteId, documento } = {}) {
  const solicitud = await prisma.solicitudDerecho.findUnique({ where: { id: solicitudId } });
  if (!solicitud || (pacienteId !== undefined && solicitud.pacienteId !== pacienteId)) throw new AppError('Solicitud no encontrada', 404);
  if (solicitud.estado !== 'recibida') throw new AppError('La solicitud ya está verificada o cerrada', 409);
  let acreditacion = solicitud.solicitanteAcreditacion;
  if (faltaAcreditar(solicitud)) {
    if (!consentimientoService.DOCUMENTOS_REPRESENTACION.includes(documento)) {
      throw new AppError('La presenta un representante: indica el documento con que acreditó la representación', 409);
    }
    if (solicitud.solicitanteRelacion === 'apoderado' && documento !== 'poder_notarial') {
      throw new AppError('Un apoderado acredita su representación con un poder notarial', 409);
    }
    acreditacion = documento;
  }

  const verificacion = await exigirVerificacion(solicitud.pacienteId, solicitante.id, METODOS_POR_DERECHO[solicitud.derecho]);
  if (verificacion.metodo === METODOS.CODIGO) {
    const cambio = await pacienteService.ultimoCambioDe(solicitud.pacienteId, 'contacto');
    if (cambio && cambio >= solicitud.recibidaEl) {
      throw new AppError('El contacto cambió después de recibir la solicitud: verifica con la cédula del titular', 403);
    }
  }

  await prisma.solicitudDerecho.update({
    where: { id: solicitudId },
    data: {
      estado: 'verificada',
      identidadVerificada: true,
      metodoVerificacion: verificacion.metodo,
      verificacionId: verificacion.id,
      verificadaPorId: solicitante.id,
      verificadaEl: new Date(),
      solicitanteAcreditacion: acreditacion,
    },
  });
  await registrar({
    usuarioId: solicitante.id,
    accion: 'VERIFICAR_SOLICITUD',
    entidad: 'Paciente',
    entidadId: solicitud.pacienteId,
    detalle: { solicitudId, metodo: verificacion.metodo },
  });
}

/**
 * Solicitudes de un paciente, para su ficha: sin el valor propuesto ni la
 * respuesta.
 *
 * @param {number} pacienteId
 * @returns {Promise<Array<{id: number, derecho: string, estado: string, canal: string,
 *   recibidaEl: Date, venceEl: Date, resueltaEl: ?Date, dentroDePlazo: boolean,
 *   pendienteDeVerificacion: boolean, metodosAceptados: string[], campo: ?string}>>}
 *
 * Consumidores: pacienteViewController.detalle.
 */
async function listarPorPaciente(pacienteId) {
  const filas = await prisma.solicitudDerecho.findMany({
    where: { pacienteId },
    orderBy: { recibidaEl: 'desc' },
    select: {
      id: true,
      derecho: true,
      estado: true,
      canal: true,
      recibidaEl: true,
      venceEl: true,
      resueltaEl: true,
      campo: true,
      metodoVerificacion: true,
      solicitanteEsRepresentante: true,
      solicitanteRelacion: true,
      solicitanteAcreditacion: true,
    },
  });
  return filas.map((f) => ({
    ...f,
    dentroDePlazo: (f.resueltaEl || new Date()) <= f.venceEl,
    pendienteDeVerificacion: f.estado === 'recibida',
    metodosAceptados: METODOS_POR_DERECHO[f.derecho],
    // Al verificarla hay que indicar el documento de la representación.
    faltaAcreditar: faltaAcreditar(f),
  }));
}

// --- Gestión (rol privacidad) ------------------------------------------------

// Por qué un paciente está bloqueado, según la solicitud que lo originó.
const MOTIVOS_BLOQUEO = {
  supresion: 'Supresión: se eliminó su contacto y sus consentimientos; los datos clínicos se conservan bloqueados porque la Ley 20.584, art. 13, obliga a conservar la ficha clínica.',
  bloqueo: 'Bloqueo a pedido del titular: los datos se conservan, pero no se usan mientras se aclara la situación.',
};

function supresionResueltaDe(pacienteId) {
  return prisma.solicitudDerecho.findFirst({ where: { pacienteId, derecho: 'supresion', estado: 'resuelta' }, select: { id: true } });
}

async function motivoBloqueoDe(pacienteId) {
  const origen = await prisma.solicitudDerecho.findFirst({
    where: { pacienteId, estado: 'resuelta', derecho: { in: ['supresion', 'bloqueo'] } },
    orderBy: { resueltaEl: 'desc' },
    select: { derecho: true },
  });
  return origen ? MOTIVOS_BLOQUEO[origen.derecho] : null;
}

const respuestaSchema = Joi.object({ respuesta: Joi.string().trim().min(3).max(2000).required() }).unknown(true).messages({
  'any.required': 'Escribe la respuesta que se le dará al titular',
  'string.empty': 'Escribe la respuesta que se le dará al titular',
});

function validarRespuesta(datos) {
  const { error, value } = respuestaSchema.validate(datos || {});
  if (error) throw new AppError(error.details[0].message, 400);
  return value.respuesta;
}

async function solicitudOError(solicitudId) {
  const solicitud = await prisma.solicitudDerecho.findUnique({ where: { id: solicitudId } });
  if (!solicitud) throw new AppError('Solicitud no encontrada', 404);
  return solicitud;
}

// Lo exige el servicio, no solo la vista: la solicitud debe estar verificada
// y con un método que acepte su derecho (supresión y bloqueo, solo cédula).
function exigirVerificada(solicitud) {
  if (solicitud.estado !== 'verificada' || !solicitud.identidadVerificada) {
    throw new AppError('La identidad del titular no está verificada: la solicitud queda pendiente hasta verificarla', 409);
  }
  if (!METODOS_POR_DERECHO[solicitud.derecho].includes(solicitud.metodoVerificacion)) {
    throw new AppError('Este derecho exige verificar la identidad con la cédula en persona', 409);
  }
  if (faltaAcreditar(solicitud)) {
    throw new AppError('La presenta un representante: falta acreditar la representación con un documento', 409);
  }
}

// Cierra la solicitud solo si sigue verificada: es una escritura condicional,
// así que de dos ejecuciones simultáneas (un doble clic) solo una la cierra y
// la otra falla. Quien llama la hace antes de los efectos y en la misma
// transacción: la segunda espera el bloqueo de la fila y no repite nada.
//
// El resultado se deduce del estado, salvo la supresión, que siempre es
// parcial (lo clínico se conserva). Una denegación total o parcial lleva el
// aviso de que el titular puede reclamar ante la Agencia (art. 11).
async function cerrar(solicitud, solicitante, { estado, respuesta, entrega }, client = prisma) {
  const resultado = estado === 'rechazada' ? 'rechazada' : solicitud.derecho === 'supresion' ? 'parcial' : 'atendida';
  const texto = resultado === 'atendida' ? respuesta : `${respuesta} ${AVISO_RECLAMO}`;
  const { count } = await client.solicitudDerecho.updateMany({
    where: { id: solicitud.id, estado: 'verificada' },
    data: { estado, resultado, respuestaCifrada: cifrar('solicitud.respuesta', texto), resueltaEl: new Date(), resueltaPorId: solicitante.id, ...(entrega ? { entrega } : {}) },
  });
  if (count !== 1) throw new AppError('La solicitud ya se resolvió', 409);
  await registrar(
    {
      usuarioId: solicitante.id,
      accion: estado === 'resuelta' ? 'EJECUTAR_DERECHO' : 'RECHAZAR_DERECHO',
      entidad: 'Paciente',
      entidadId: solicitud.pacienteId,
      detalle: { solicitudId: solicitud.id, derecho: solicitud.derecho, resultado },
    },
    client,
  );
}

// Lo irreversible (supresión y bloqueo) lo ejecuta una persona distinta de
// quien verificó la identidad del titular: nadie puede, solo, verificar a un
// supuesto titular y borrar sus datos (cuatro ojos).
const IRREVERSIBLES = ['supresion', 'bloqueo'];

function exigirCuatroOjos(solicitud, solicitante) {
  if (IRREVERSIBLES.includes(solicitud.derecho) && solicitud.verificadaPorId === solicitante.id) {
    throw new AppError('La supresión y el bloqueo los ejecuta una persona distinta de quien verificó la identidad del titular', 409);
  }
}

/**
 * Solicitudes abiertas, de la más próxima a vencer a la más lejana, con el
 * nombre del titular (lectura auditada).
 *
 * @param {{id: number}} solicitante - req.usuario.
 * @returns {Promise<Array<object>>}
 *
 * Consumidores: solicitudViewController.index.
 */
async function listarPendientes(solicitante) {
  const filas = await prisma.solicitudDerecho.findMany({
    where: { estado: { in: ['recibida', 'verificada'] } },
    orderBy: { venceEl: 'asc' },
    select: { id: true, pacienteId: true, derecho: true, estado: true, canal: true, recibidaEl: true, venceEl: true, metodoVerificacion: true, prorrogadaEl: true },
  });
  const nombres = filas.length ? await pacienteService.nombresDe([...new Set(filas.map((f) => f.pacienteId))], solicitante.id) : new Map();
  const ahora = new Date();
  return filas.map((f) => ({
    ...f,
    paciente: nombres.get(f.pacienteId),
    dentroDePlazo: ahora <= f.venceEl,
    porVencer: ahora <= f.venceEl && f.venceEl <= sumarDias(ahora, AVISO_VENCIMIENTO_DIAS),
    pendienteDeVerificacion: f.estado === 'recibida',
  }));
}

const prorrogaSchema = Joi.object({
  dias: Joi.number().integer().min(1).max(PRORROGA_MAXIMA_DIAS).required().messages({ 'number.max': `La prórroga es de hasta ${PRORROGA_MAXIMA_DIAS} días`, 'any.required': 'Indica cuántos días se prorroga' }),
  motivo: Joi.string().trim().min(10).max(1000).required().messages({ 'any.required': 'Explica al titular por qué se prorroga', 'string.min': 'Explica al titular por qué se prorroga' }),
}).unknown(true);

/**
 * Prorroga el plazo de una solicitud abierta, una sola vez y hasta por 30
 * días (Ley 21.719, art. 11), con el motivo que se le informa al titular.
 * El bloqueo no se prorroga: es temporal y su plazo es de 2 días hábiles.
 *
 * @param {number} solicitudId
 * @param {{id: number}} solicitante - req.usuario (privacidad).
 * @param {{dias: number, motivo: string}} datos
 * @returns {Promise<{venceEl: Date}>} el nuevo vencimiento.
 * @throws {AppError} 400 sin motivo o con más de 30 días; 409 si está
 *   cerrada, ya se prorrogó, ya venció o es un bloqueo.
 *
 * Consumidores: solicitudViewController.prorrogar.
 */
async function prorrogar(solicitudId, solicitante, datos) {
  const { error, value } = prorrogaSchema.validate(datos || {});
  if (error) throw new AppError(error.details[0].message, 400);
  const solicitud = await solicitudOError(solicitudId);
  if (solicitud.derecho === 'bloqueo') throw new AppError('El bloqueo no se prorroga: se responde dentro de 2 días hábiles', 409);
  // Se prorroga antes de vencer: después ya no hay plazo que extender.
  if (solicitud.venceEl < new Date()) throw new AppError('El plazo ya venció: no se puede prorrogar', 409);
  const venceEl = sumarDias(solicitud.venceEl, value.dias);
  const { count } = await prisma.solicitudDerecho.updateMany({
    where: { id: solicitudId, estado: { in: ['recibida', 'verificada'] }, prorrogadaEl: null },
    data: { venceEl, prorrogadaEl: new Date(), prorrogaMotivoCifrado: cifrar('solicitud.prorroga', value.motivo) },
  });
  if (count !== 1) throw new AppError('La solicitud está cerrada o ya se prorrogó una vez', 409);
  await registrar({ usuarioId: solicitante.id, accion: 'PRORROGAR_DERECHO', entidad: 'Paciente', entidadId: solicitud.pacienteId, detalle: { solicitudId, dias: value.dias } });
  const contacto = (await pacienteService.contactosParaProceso([solicitud.pacienteId])).get(solicitud.pacienteId);
  if (contacto) {
    // El motivo no viaja en el mensaje: el titular lo ve en el portal o en su archivo.
    await canalEnvio
      .enviar(contacto, `MediBox: la respuesta a su solicitud número ${solicitudId} se prorrogó hasta el ${fechaDMA(isoLocal(venceEl).slice(0, 10))}. Puede ver el motivo en el portal del paciente.`)
      .catch(() => {});
  }
  return { venceEl };
}

/**
 * Avisa a quienes resuelven solicitudes (permiso derechos.gestionar) cuántas
 * están vencidas y cuántas vencen en los próximos 3 días. El aviso no
 * identifica a ningún titular.
 *
 * @param {Date} [ahora]
 * @returns {Promise<{porVencer: number, vencidas: number, avisados: number}>}
 *
 * Consumidores: src/alertas.js (npm run alertas, diario).
 */
async function avisarVencimientos(ahora = new Date()) {
  const abiertas = { estado: { in: ['recibida', 'verificada'] } };
  const [porVencer, vencidas] = await Promise.all([
    prisma.solicitudDerecho.count({ where: { ...abiertas, venceEl: { gte: ahora, lte: sumarDias(ahora, AVISO_VENCIMIENTO_DIAS) } } }),
    prisma.solicitudDerecho.count({ where: { ...abiertas, venceEl: { lt: ahora } } }),
  ]);
  let avisados = 0;
  if (porVencer + vencidas > 0) {
    const responsables = await prisma.usuario.findMany({
      where: { rol: { permisos: { some: { permiso: { clave: 'derechos.gestionar' } } } } },
      select: { id: true },
    });
    for (const { id } of responsables) {
      await crearNotificacion({ usuarioId: id, mensaje: `Solicitudes de derechos: ${vencidas} vencida${vencidas === 1 ? '' : 's'} y ${porVencer} por vencer en ${AVISO_VENCIMIENTO_DIAS} días. Revisa Solicitudes.` });
      avisados += 1;
    }
  }
  const resumen = { porVencer, vencidas, avisados };
  await registrar({ actor: 'sistema', accion: 'AVISO_VENCIMIENTOS', entidad: 'Sistema', entidadId: 0, detalle: resumen });
  return resumen;
}

/**
 * Todo lo que privacidad necesita para resolver una solicitud: la solicitud
 * (con el valor propuesto descifrado), la ficha del titular, sus
 * consentimientos y su historial.
 *
 * @param {number} solicitudId
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {Promise<object>}
 *
 * Consumidores: solicitudViewController.detalle.
 */
async function obtenerParaGestion(solicitudId, solicitante) {
  const solicitud = await solicitudOError(solicitudId);
  // Con la solicitud cerrada ya no hace falta la ficha completa: solo quién
  // es el titular y si está bloqueado (para levantar el bloqueo o registrar
  // una solicitud nueva). Así una solicitud vieja no reabre su ficha.
  const abierta = solicitud.estado === 'recibida' || solicitud.estado === 'verificada';
  const paciente = await pacienteService.obtenerFichaParaGestion(solicitud.pacienteId, solicitante, { solicitudId, completa: abierta });
  return {
    solicitud: {
      ...solicitud,
      valorPropuesto: solicitud.valorPropuestoCifrado ? descifrar(`solicitud.valor.${solicitud.campo}`, solicitud.valorPropuestoCifrado) : null,
      respuesta: solicitud.respuestaCifrada ? descifrar('solicitud.respuesta', solicitud.respuestaCifrada) : null,
      motivoProrroga: solicitud.prorrogaMotivoCifrado ? descifrar('solicitud.prorroga', solicitud.prorrogaMotivoCifrado) : null,
      metodosAceptados: METODOS_POR_DERECHO[solicitud.derecho],
      faltaAcreditar: faltaAcreditar(solicitud),
    },
    documentos: consentimientoService.DOCUMENTOS_REPRESENTACION,
    relaciones: RELACIONES_SOLICITUD,
    paciente: {
      ...paciente,
      motivoBloqueo: paciente.bloqueado ? await motivoBloqueoDe(solicitud.pacienteId) : null,
      suprimido: Boolean(await supresionResueltaDe(solicitud.pacienteId)),
    },
    consentimientos: abierta ? await consentimientoService.estadoPorPaciente(solicitud.pacienteId) : [],
    historial: abierta ? await pacienteService.listarHistorial(solicitud.pacienteId) : [],
  };
}

/**
 * Ejecuta una solicitud verificada (paso 4) y registra la respuesta al
 * titular (paso 5). Acceso y portabilidad se resuelven al descargar el
 * archivo (exportarDatosTitular).
 *
 * @param {number} solicitudId
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @param {{respuesta: string}} datos - lo que se le responde al titular.
 * @returns {Promise<void>}
 * @throws {AppError} 409 sin la verificación aceptada o si es acceso o
 *   portabilidad; 400 sin respuesta.
 *
 * Consumidores: solicitudViewController.ejecutar.
 */
async function ejecutar(solicitudId, solicitante, datos) {
  const solicitud = await solicitudOError(solicitudId);
  exigirVerificada(solicitud);
  const respuesta = validarRespuesta(datos);
  const { pacienteId } = solicitud;
  const marca = { usuarioId: solicitante.id, solicitudId };

  if (solicitud.derecho === 'acceso' || solicitud.derecho === 'portabilidad') {
    throw new AppError('El acceso y la portabilidad se resuelven al generar el archivo del titular', 409);
  }

  exigirCuatroOjos(solicitud, solicitante);

  // En cada caso se cierra primero (escritura condicional) y después se
  // aplican los efectos, en la misma transacción: todo o nada, y una
  // ejecución repetida no aplica nada dos veces.
  if (solicitud.derecho === 'rectificacion') {
    const actual = await pacienteService.datosParaTitular(pacienteId);
    const valor = descifrar(`solicitud.valor.${solicitud.campo}`, solicitud.valorPropuestoCifrado);
    await prisma.$transaction(async (tx) => {
      await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta }, tx);
      await pacienteService.actualizarPaciente(pacienteId, { ...actual, [solicitud.campo]: valor }, solicitante.id, { solicitudId, client: tx });
    });
    return;
  }

  if (solicitud.derecho === 'oposicion') {
    await prisma.$transaction(async (tx) => {
      await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta }, tx);
      await consentimientoService.revocarAbiertos(pacienteId, { finalidadClave: solicitud.finalidadClave, canal: solicitud.canal, usuarioId: solicitante.id, verificacionId: solicitud.verificacionId }, tx);
    });
    return;
  }

  // Supresión y bloqueo: lo que la ley no obliga a conservar se elimina de
  // verdad; lo clínico se conserva bloqueado.
  await prisma.$transaction(async (tx) => {
    await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta }, tx);
    if (solicitud.derecho === 'supresion') {
      await pacienteService.suprimirContacto(pacienteId, marca, tx);
      await consentimientoService.revocarAbiertos(pacienteId, { canal: solicitud.canal, usuarioId: solicitante.id, verificacionId: solicitud.verificacionId }, tx);
      await tx.consentimiento.updateMany({ where: { pacienteId, representanteCifrado: { not: null } }, data: { representanteCifrado: null } });
    }
    await pacienteService.cambiarBloqueo(pacienteId, true, marca, tx);
  });

  // Un paciente bloqueado no se atiende con lo agendado: se anulan sus citas
  // futuras (cada una auditada y avisada al médico, como cualquier anulación).
  for (const citaId of await citaService.futurasDe(pacienteId)) {
    await citaService.anularCita(citaId, solicitante.id);
  }

  // La supresión queda anotada fuera de la base, para reaplicarla si se
  // restaura un respaldo anterior. Ya está aplicada y respondida: si el
  // archivo no se puede escribir, no se le devuelve un error al funcionario
  // (repetirla daría 409), sino que queda en la auditoría como fallida para
  // que el administrador la anote a mano antes de cualquier restauración.
  if (solicitud.derecho === 'supresion') {
    try {
      registrarSupresion(pacienteId, solicitudId);
    } catch (err) {
      logger.error({ err: { code: err.code }, solicitudId }, 'No se pudo anotar la supresión en registro/supresiones.jsonl');
      await registrar({ actor: 'sistema', accion: 'ANOTAR_SUPRESION', entidad: 'Paciente', entidadId: pacienteId, resultado: 'fallido', detalle: { solicitudId } });
    }
  }
}

/**
 * Rechaza una solicitud por el fondo (por ejemplo, una rectificación
 * improcedente). Nunca por falta de verificación: esa queda pendiente.
 *
 * @param {number} solicitudId
 * @param {{id: number}} solicitante - req.usuario.
 * @param {{respuesta: string}} datos - el motivo, para el titular.
 * @returns {Promise<void>}
 * @throws {AppError} 409 si no está verificada; 400 sin respuesta.
 *
 * Consumidores: solicitudViewController.rechazar.
 */
async function rechazar(solicitudId, solicitante, datos) {
  const solicitud = await solicitudOError(solicitudId);
  exigirVerificada(solicitud);
  await cerrar(solicitud, solicitante, { estado: 'rechazada', respuesta: validarRespuesta(datos) });
}

/**
 * Levanta el bloqueo que originó una solicitud de bloqueo ya resuelta,
 * cuando se aclaró la situación. Un bloqueo por supresión no se levanta,
 * aunque el titular haya pedido antes un bloqueo.
 *
 * @param {number} solicitudId - la solicitud de bloqueo.
 * @param {{id: number}} solicitante - req.usuario.
 * @returns {Promise<void>}
 * @throws {AppError} 409 si la solicitud no es un bloqueo resuelto o si el
 *   titular tiene una supresión resuelta.
 *
 * Consumidores: solicitudViewController.desbloquear.
 */
async function desbloquear(solicitudId, solicitante) {
  const solicitud = await solicitudOError(solicitudId);
  if (solicitud.derecho !== 'bloqueo' || solicitud.estado !== 'resuelta') {
    throw new AppError('Solo se levanta un bloqueo que se pidió como bloqueo y ya se resolvió', 409);
  }
  if (await supresionResueltaDe(solicitud.pacienteId)) {
    throw new AppError('El titular ejerció la supresión: su bloqueo es permanente', 409);
  }
  await pacienteService.cambiarBloqueo(solicitud.pacienteId, false, { usuarioId: solicitante.id, solicitudId });
}

// Rol del funcionario que aparece en "quién accedió a sus datos": el titular
// sabe qué función accedió, sin el nombre del funcionario (dato de otra persona).
const ETIQUETA_ACTOR = { sistema: 'Sistema', titular: 'Usted, en el portal', portal: 'Intento de ingreso al portal' };
const ETIQUETA_ROL = { operador: 'Admisión', medico: 'Médico tratante', gestor: 'Gestión', privacidad: 'Protección de datos', consulta: 'Informaciones', admin: 'Administración' };

/**
 * Resuelve una solicitud de acceso o portabilidad: en persona, genera el
 * archivo del titular (todos sus datos y nada de otras personas ni datos
 * internos) para que el funcionario se lo entregue; al contacto registrado,
 * no genera nada: le avisa que lo descargue en el portal. Marca la solicitud
 * como resuelta con su entrega.
 *
 * @param {number} solicitudId
 * @param {{id: number}} solicitante - req.usuario.
 * @param {{entrega: ('contacto_registrado'|'presencial'), formato?: string}} opciones
 *   entrega: nunca el canal por el que llamaron, sino en persona o al
 *   contacto ya registrado. formato: 'excel', 'pdf' o 'json', para la auditoría.
 * @returns {Promise<(object|null)>} el archivo, o null si se avisó al contacto.
 * @throws {AppError} 409 si no es acceso o portabilidad, si no está
 *   verificada, si el contacto falta o cambió después de la solicitud, o si
 *   no se le pudo avisar.
 *
 * Consumidores: solicitudViewController.descargar.
 */
async function exportarDatosTitular(solicitudId, solicitante, { entrega, formato }) {
  const solicitud = await solicitudOError(solicitudId);
  if (solicitud.derecho !== 'acceso' && solicitud.derecho !== 'portabilidad') throw new AppError('Esta solicitud no es de acceso ni de portabilidad', 409);
  exigirVerificada(solicitud);
  if (!['contacto_registrado', 'presencial'].includes(entrega)) throw new AppError('Indica cómo se entrega: en persona o al contacto registrado', 400);

  const { pacienteId } = solicitud;
  if (entrega === 'contacto_registrado') {
    const { contacto } = await pacienteService.datosParaTitular(pacienteId);
    const cambio = await pacienteService.ultimoCambioDe(pacienteId, 'contacto');
    if (!contacto || (cambio && cambio >= solicitud.recibidaEl)) {
      throw new AppError('El contacto falta o cambió después de la solicitud: entrega el archivo en persona', 409);
    }
    // A distancia el archivo no pasa por el funcionario ni por su correo: se
    // le avisa al contacto registrado que lo descargue en el portal, donde
    // entra con un código de un solo uso y una sesión de 15 minutos
    // (autenticación reciente y temporal, clase PR 05). Se genera con los
    // datos vigentes al descargarlo.
    try {
      await canalEnvio.enviar(
        contacto,
        `MediBox: la copia de sus datos que pidió (solicitud número ${solicitudId}) está disponible en el portal del paciente. Ingrese con su RUT y el código que le llegará a este mismo contacto.`,
      );
    } catch {
      throw new AppError('No se pudo avisar al contacto registrado (el portal solo envía códigos por correo): entrega el archivo en persona', 409);
    }
    await prisma.$transaction(async (tx) => {
      await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta: 'Se puso a su disposición una copia de sus datos en el portal del paciente, con aviso al contacto registrado.', entrega }, tx);
      await registrar({ usuarioId: solicitante.id, accion: 'AVISAR_ENTREGA', entidad: 'Paciente', entidadId: pacienteId, detalle: { solicitudId, entrega } }, tx);
    });
    return null;
  }

  const archivo = await armarArchivoTitular(pacienteId);
  await prisma.$transaction(async (tx) => {
    await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta: 'Se le entregó en persona una copia de sus datos.', entrega }, tx);
    await registrar({ usuarioId: solicitante.id, accion: 'EXPORT_TITULAR', entidad: 'Paciente', entidadId: pacienteId, detalle: { solicitudId, entrega, formato } }, tx);
  });
  return archivo;
}

// Cada cambio con su valor anterior y su valor nuevo. Solo se guarda el
// anterior (cifrado): el nuevo es el anterior del cambio siguiente del mismo
// dato, o el valor actual si es el último, así que no se duplica. Sin valor
// si la supresión o la retención ya lo eliminaron.
function conValorNuevo(historial, actual) {
  const anteriores = historial.map((h) => (h.valorAnteriorCifrado ? descifrar(`historial.${h.campo}`, h.valorAnteriorCifrado) : null));
  return historial.map((h, i) => {
    const siguiente = historial.findIndex((o, j) => j > i && o.campo === h.campo);
    return {
      campo: h.campo,
      cambiadoEl: h.cambiadoEl,
      valorAnterior: anteriores[i],
      valorNuevo: siguiente === -1 ? actual[h.campo] ?? null : anteriores[siguiente],
    };
  });
}

/**
 * El archivo del titular: un JSON con todos sus datos y nada de otras
 * personas ni datos internos (ids, hashes o blobs). No audita: lo hace quien
 * lo entrega.
 *
 * @param {number} pacienteId
 * @returns {Promise<object>}
 *
 * Consumidores: exportarDatosTitular(), exportarDesdePortal(), portalService.misDatos.
 */
async function armarArchivoTitular(pacienteId) {
  const titular = await pacienteService.datosParaTitular(pacienteId);
  const [citas, consentimientos, solicitudes, historial, accesos] = await Promise.all([
    citaService.listarParaTitular(pacienteId),
    prisma.consentimiento.findMany({
      where: { pacienteId },
      orderBy: { otorgadoEl: 'asc' },
      select: { otorgadoEl: true, revocadoEl: true, canal: true, revocacionCanal: true, otorgadoPor: true, representanteCifrado: true, finalidad: { select: { nombre: true } }, texto: { select: { version: true, texto: true } } },
    }),
    prisma.solicitudDerecho.findMany({
      where: { pacienteId },
      orderBy: { recibidaEl: 'asc' },
      select: {
        id: true,
        derecho: true,
        estado: true,
        resultado: true,
        canal: true,
        campo: true,
        recibidaEl: true,
        verificadaEl: true,
        venceEl: true,
        prorrogadaEl: true,
        prorrogaMotivoCifrado: true,
        resueltaEl: true,
        respuestaCifrada: true,
      },
    }),
    // Con el valor anterior: la rectificación conserva qué había, y ese dato
    // es del propio titular (no lo ve nadie más).
    prisma.historialCambio.findMany({ where: { pacienteId }, orderBy: { cambiadoEl: 'asc' }, select: { campo: true, cambiadoEl: true, valorAnteriorCifrado: true } }),
    prisma.auditLog.findMany({
      where: { entidad: 'Paciente', entidadId: pacienteId },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, accion: true, actor: true, resultado: true, usuario: { select: { rol: { select: { nombre: true } } } } },
    }),
  ]);

  const archivo = {
    generadoEl: new Date().toISOString(),
    titular,
    citas,
    consentimientos: consentimientos.map((c) => ({
      finalidad: c.finalidad.nombre,
      versionTexto: c.texto.version,
      texto: c.texto.texto,
      otorgadoEl: c.otorgadoEl,
      canal: c.canal,
      // Del representante solo su relación con el titular: sus datos son de otra persona.
      otorgadoPor: c.otorgadoPor === 'representante' && c.representanteCifrado
        ? `representante (${JSON.parse(descifrar('consentimiento.representante', c.representanteCifrado)).relacion})`
        : c.otorgadoPor,
      revocadoEl: c.revocadoEl,
      canalRevocacion: c.revocacionCanal,
    })),
    // La respuesta y el motivo de una prórroga son lo que el hospital le
    // contestó al titular: son suyos. El id es su número de seguimiento.
    solicitudes: solicitudes.map(({ id, respuestaCifrada, prorrogaMotivoCifrado, ...s }) => ({
      numero: id,
      ...s,
      motivoProrroga: prorrogaMotivoCifrado ? descifrar('solicitud.prorroga', prorrogaMotivoCifrado) : null,
      respuesta: respuestaCifrada ? descifrar('solicitud.respuesta', respuestaCifrada) : null,
    })),
    historialCambios: conValorNuevo(historial, titular),
    accesos: accesos.map((a) => ({
      fecha: a.timestamp,
      accion: a.accion,
      resultado: a.resultado,
      rol: ETIQUETA_ACTOR[a.actor] || ETIQUETA_ROL[a.usuario && a.usuario.rol.nombre] || 'Funcionario',
    })),
    tratamiento: TRATAMIENTO,
  };
  return archivo;
}

/**
 * Descarga del archivo por el propio titular en el portal: queda como una
 * solicitud de portabilidad ya resuelta, verificada con su código y
 * entregada en el portal, y en la auditoría como EXPORT_TITULAR del titular.
 *
 * @param {number} pacienteId - el de la sesión del portal.
 * @param {number} verificacionId - el código con que ingresó.
 * @param {string} formato - 'excel' o 'pdf', para la auditoría.
 * @returns {Promise<object>} el archivo.
 *
 * Consumidores: portalService.descargar.
 */
async function exportarDesdePortal(pacienteId, verificacionId, formato) {
  const archivo = await armarArchivoTitular(pacienteId);
  const ahora = new Date();
  await prisma.$transaction(async (tx) => {
    const { id: solicitudId } = await tx.solicitudDerecho.create({
      data: {
        pacienteId,
        derecho: 'portabilidad',
        canal: CANAL_PORTAL,
        estado: 'resuelta',
        recibidaEl: ahora,
        venceEl: calcularVencimiento('portabilidad', ahora),
        identidadVerificada: true,
        verificadaEl: ahora,
        resultado: 'atendida',
        metodoVerificacion: METODOS.PORTAL,
        verificacionId,
        entrega: CANAL_PORTAL,
        respuestaCifrada: cifrar('solicitud.respuesta', 'Descargó una copia de sus datos en el portal.'),
        resueltaEl: ahora,
      },
      select: { id: true },
    });
    await registrar({ actor: 'titular', accion: 'EXPORT_TITULAR', entidad: 'Paciente', entidadId: pacienteId, detalle: { solicitudId, entrega: CANAL_PORTAL, formato } }, tx);
  });
  return archivo;
}

module.exports = {
  DERECHOS,
  PLAZO_RESPUESTA_DIAS,
  PRORROGA_MAXIMA_DIAS,
  AVISO_RECLAMO,
  calcularVencimiento,
  prorrogar,
  avisarVencimientos,
  METODOS_POR_DERECHO,
  RELACIONES_SOLICITUD,
  registrarSolicitud,
  verificarSolicitud,
  listarPorPaciente,
  listarPendientes,
  obtenerParaGestion,
  ejecutar,
  rechazar,
  desbloquear,
  exportarDatosTitular,
  armarArchivoTitular,
  exportarDesdePortal,
  registrarDesdePortal,
  CANAL_PORTAL,
  DERECHOS_PORTAL,
};
