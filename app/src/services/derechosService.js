const Joi = require('joi');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { cifrar } = require('../lib/cifrado');
const { normalizarRut, rutValido } = require('../lib/rut');
const { registrar } = require('./auditService');
const pacienteService = require('./pacienteService');
const consentimientoService = require('./consentimientoService');
const { METODOS, exigirVerificacion } = require('./verificacionService');

// Derechos del titular (ARCO+, Hito 3). Los cinco pasos de la clase:
//   1. Recepción: un funcionario registra la solicitud, por el canal por el
//      que llegó, sin costo y sin exigir todavía la verificación.
//   2. Verificación de identidad, con el método que acepta cada derecho.
//   3. Registro: queda con su fecha, el derecho y su vencimiento.
//   4. Ejecución (rol privacidad), solo si la identidad está verificada.
//   5. Respuesta al titular, registrada y cifrada.

const DERECHOS = ['acceso', 'portabilidad', 'rectificacion', 'supresion', 'bloqueo', 'oposicion'];

// Plazo para responder, en días corridos desde la recepción. Ley 21.719
// (rige desde el 01/12/2026): plazo de respuesta del responsable a una
// solicitud de derechos; Ley 19.628, art. 16, para el régimen vigente.
// a confirmar con la línea jurídica (plazo y si es prorrogable).
const PLAZO_RESPUESTA_DIAS = 30;

// Qué método de verificación acepta cada derecho: una sola fuente para la
// vista (qué ofrecer) y el servicio (qué aceptar). La supresión y el bloqueo
// son irreversibles: solo con la cédula vista en persona.
const METODOS_POR_DERECHO = {
  acceso: [METODOS.CEDULA, METODOS.CODIGO],
  portabilidad: [METODOS.CEDULA, METODOS.CODIGO],
  rectificacion: [METODOS.CEDULA, METODOS.CODIGO],
  oposicion: [METODOS.CEDULA, METODOS.CODIGO],
  supresion: [METODOS.CEDULA],
  bloqueo: [METODOS.CEDULA],
};

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
  solicitanteRelacion: Joi.string().valid(...consentimientoService.RELACIONES).empty(''),
});

function sumarDias(fecha, dias) {
  return new Date(fecha.getTime() + dias * 24 * 60 * 60 * 1000);
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
 * @returns {Promise<{id: number, venceEl: Date}>}
 * @throws {AppError} 400 si faltan datos o son inválidos; 404 si el
 *   paciente está fuera de su alcance.
 *
 * Consumidores: pacienteViewController.registrarSolicitud.
 */
async function registrarSolicitud({ pacienteId, ...cuerpo }, solicitante) {
  const { error, value } = solicitudSchema.validate(cuerpo, { stripUnknown: true });
  if (error) throw new AppError(error.details[0].message, 400);
  await pacienteService.exigirAlcance(pacienteId, solicitante);

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

  const recibidaEl = new Date();
  const fila = await prisma.solicitudDerecho.create({
    data: {
      pacienteId,
      derecho: value.derecho,
      canal: value.canal,
      recibidaEl,
      venceEl: sumarDias(recibidaEl, PLAZO_RESPUESTA_DIAS),
      recibidaPorId: solicitante.id,
      solicitanteEsRepresentante: value.solicitanteEsRepresentante,
      solicitanteRelacion: value.solicitanteEsRepresentante ? value.solicitanteRelacion || null : null,
      campo: value.campo || null,
      valorPropuestoCifrado,
      finalidadClave: value.finalidadClave || null,
    },
    select: { id: true, venceEl: true },
  });
  await registrar({ usuarioId: solicitante.id, accion: 'SOLICITAR', entidad: 'Paciente', entidadId: pacienteId, detalle: { solicitudId: fila.id, derecho: value.derecho, canal: value.canal } });
  return fila;
}

/**
 * Adjunta a la solicitud la verificación de identidad vigente del
 * funcionario (paso 2), si su método es uno que acepta ese derecho. Un
 * código solo vale si el contacto no cambió después de recibir la solicitud.
 *
 * @param {number} solicitudId
 * @param {{id: number}} solicitante - req.usuario.
 * @param {{pacienteId?: number}} [opciones] - el paciente de la ruta: la
 *   solicitud debe ser suya.
 * @returns {Promise<void>}
 * @throws {AppError} 403 sin una verificación aceptada; 409 si ya estaba
 *   verificada o cerrada; 404 si no existe o es de otro paciente.
 *
 * Consumidores: pacienteViewController.verificarSolicitud, solicitudViewController.
 */
async function verificarSolicitud(solicitudId, solicitante, { pacienteId } = {}) {
  const solicitud = await prisma.solicitudDerecho.findUnique({ where: { id: solicitudId } });
  if (!solicitud || (pacienteId !== undefined && solicitud.pacienteId !== pacienteId)) throw new AppError('Solicitud no encontrada', 404);
  if (solicitud.estado !== 'recibida') throw new AppError('La solicitud ya está verificada o cerrada', 409);

  const verificacion = await exigirVerificacion(solicitud.pacienteId, solicitante.id, METODOS_POR_DERECHO[solicitud.derecho]);
  if (verificacion.metodo === METODOS.CODIGO) {
    const cambio = await pacienteService.ultimoCambioDe(solicitud.pacienteId, 'contacto');
    if (cambio && cambio >= solicitud.recibidaEl) {
      throw new AppError('El contacto cambió después de recibir la solicitud: verifica con la cédula del titular', 403);
    }
  }

  await prisma.solicitudDerecho.update({
    where: { id: solicitudId },
    data: { estado: 'verificada', identidadVerificada: true, metodoVerificacion: verificacion.metodo, verificacionId: verificacion.id, verificadaPorId: solicitante.id },
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
    select: { id: true, derecho: true, estado: true, canal: true, recibidaEl: true, venceEl: true, resueltaEl: true, campo: true, metodoVerificacion: true },
  });
  return filas.map((f) => ({
    ...f,
    dentroDePlazo: (f.resueltaEl || new Date()) <= f.venceEl,
    pendienteDeVerificacion: f.estado === 'recibida',
    metodosAceptados: METODOS_POR_DERECHO[f.derecho],
  }));
}

module.exports = {
  DERECHOS,
  PLAZO_RESPUESTA_DIAS,
  METODOS_POR_DERECHO,
  registrarSolicitud,
  verificarSolicitud,
  listarPorPaciente,
};
