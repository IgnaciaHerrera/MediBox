const Joi = require('joi');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { cifrar, descifrar } = require('../lib/cifrado');
const { normalizarRut, rutValido } = require('../lib/rut');
const { registrar } = require('./auditService');
const pacienteService = require('./pacienteService');
const { METODOS, exigirVerificacion } = require('./verificacionService');

// Consentimiento por finalidad (Hito 3). Solo para las finalidades
// secundarias del catálogo (recordatorios, investigación, encuestas): la
// atención no depende de él y ningún servicio de la atención lo consulta.
//
// Otorgar y revocar siguen el mismo procedimiento: el titular lo pide por
// cualquier canal, un funcionario verifica su identidad (cédula o código) y
// lo registra con un clic. Revocar no borra nada y tiene efecto inmediato:
// tieneVigente() lee la base en cada llamada.

const METODOS_CONSENTIMIENTO = [METODOS.CEDULA, METODOS.CODIGO];
const CANALES = ['presencial', 'telefono', 'correo'];
// Ley 21.719, art. 16 quáter: por un niño o niña (menor de 14) consiente
// quien tiene su cuidado personal; un adolescente consiente él mismo, salvo
// que la finalidad trate datos sensibles: entonces, hasta los 16 años,
// también consiente su representante.
const EDAD_CONSENTIMIENTO_PROPIO = 14;
const EDAD_SENSIBLES_PROPIO = 16;
const RELACIONES = ['madre', 'padre', 'tutor_legal', 'otro'];
// Documento con que se acredita la representación (solo se guarda el tipo,
// nunca una copia). 'declarada' cuando no se pudo ver: por teléfono, por
// correo o en el portal. En admisión siempre se pide el documento.
const DOCUMENTOS_REPRESENTACION = ['certificado_nacimiento', 'resolucion_judicial', 'poder_notarial'];
const DECLARADA = 'declarada';

const representanteSchema = Joi.object({
  nombre: Joi.string().trim().min(2).max(150).required(),
  rut: Joi.string()
    .max(12)
    .required()
    .custom((valor, helpers) => (rutValido(valor) ? normalizarRut(valor) : helpers.message('El RUT del representante no es válido'))),
  relacion: Joi.string().valid(...RELACIONES).required(),
  documento: Joi.string()
    .valid(...DOCUMENTOS_REPRESENTACION, DECLARADA)
    .required()
    .messages({ 'any.only': 'indica con qué documento acreditó la representación', 'any.required': 'indica con qué documento acreditó la representación' }),
});

/**
 * Si el consentimiento (o la solicitud) debe darlo el representante.
 *
 * @param {number} edad - años cumplidos del titular.
 * @param {{datosSensibles?: boolean}} [finalidad] - la finalidad que se
 *   consiente; sin ella (solicitudes de derechos) solo cuenta la regla de los 14.
 * @returns {boolean}
 *
 * Consumidores: registrarOtorgamiento(), conRepresentante(),
 *   derechosService.crearSolicitud, pacienteViewController.
 */
function requiereRepresentante(edad, { datosSensibles = false } = {}) {
  return edad < EDAD_CONSENTIMIENTO_PROPIO || (datosSensibles && edad < EDAD_SENSIBLES_PROPIO);
}

/**
 * Marca en cada finalidad del estado si, a esa edad, la consiente el representante.
 *
 * @param {Array<object>} estado - lo que devuelve estadoPorPaciente().
 * @param {number} edad
 * @returns {Array<object>} el mismo estado, con requiereRepresentante en cada finalidad.
 *
 * Consumidores: pacienteViewController.detalle, portalService.misDatos.
 */
function conRepresentante(estado, edad) {
  return estado.map((e) => ({ ...e, requiereRepresentante: requiereRepresentante(edad, e.finalidad) }));
}

function validarCanal(canal) {
  if (!CANALES.includes(canal)) throw new AppError('Indica por qué canal llegó la petición', 400);
}

async function finalidadPorClave(clave) {
  const finalidad = await prisma.finalidad.findFirst({
    where: { clave, activa: true },
    include: { textos: { orderBy: { version: 'desc' }, take: 1 } },
  });
  if (!finalidad) throw new AppError('Finalidad desconocida', 400);
  return finalidad;
}

function estadoDe(ultimo, versionVigente) {
  if (!ultimo) return 'sin_otorgar';
  if (ultimo.revocadoEl) return 'revocado';
  return ultimo.texto.version < versionVigente ? 'a_renovar' : 'vigente';
}

/**
 * Estado de cada finalidad para un paciente: el de su último otorgamiento.
 * Un consentimiento dado sobre un texto anterior queda 'a_renovar' y no
 * permite el tratamiento hasta renovarlo.
 *
 * @param {number} pacienteId
 * @returns {Promise<Array<{finalidad: {clave: string, nombre: string, datosSensibles: boolean},
 *   estado: ('vigente'|'revocado'|'a_renovar'|'sin_otorgar'), otorgadoEl: ?Date,
 *   revocadoEl: ?Date, version: ?number, versionVigente: number, canal: ?string,
 *   otorgadoPor: ?string, metodoVerificacion: ?string, registradoPor: ?string,
 *   textoVigente: {id: number, version: number, texto: string}}>>}
 *
 * Consumidores: tieneVigente(), pacienteViewController.detalle, derechosService.
 */
async function estadoPorPaciente(pacienteId) {
  const finalidades = await prisma.finalidad.findMany({
    where: { activa: true },
    orderBy: { id: 'asc' },
    include: {
      textos: { orderBy: { version: 'desc' }, take: 1 },
      consentimientos: {
        where: { pacienteId },
        orderBy: { id: 'desc' },
        take: 1,
        select: {
          otorgadoEl: true,
          revocadoEl: true,
          canal: true,
          otorgadoPor: true,
          texto: { select: { version: true } },
          verificacion: { select: { metodo: true } },
          registradoPor: { select: { nombre: true } },
        },
      },
    },
  });

  return finalidades.map((f) => {
    const [vigente] = f.textos;
    const [ultimo] = f.consentimientos;
    return {
      finalidad: { clave: f.clave, nombre: f.nombre, datosSensibles: f.datosSensibles },
      estado: estadoDe(ultimo, vigente.version),
      otorgadoEl: ultimo ? ultimo.otorgadoEl : null,
      revocadoEl: ultimo ? ultimo.revocadoEl : null,
      version: ultimo ? ultimo.texto.version : null,
      versionVigente: vigente.version,
      canal: ultimo ? ultimo.canal : null,
      otorgadoPor: ultimo ? ultimo.otorgadoPor : null,
      metodoVerificacion: ultimo ? ultimo.verificacion.metodo : null,
      registradoPor: ultimo ? (ultimo.registradoPor ? ultimo.registradoPor.nombre : 'el titular, en el portal') : null,
      textoVigente: { id: vigente.id, version: vigente.version, texto: vigente.texto },
    };
  });
}

/**
 * Registra el consentimiento del titular (o de su representante) para una
 * finalidad, sobre la versión vigente del texto.
 *
 * @param {{pacienteId: number, finalidadClave: string, textoId: number,
 *   canal: string, representante?: {nombre: string, rut: string, relacion: string}}} datos
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {Promise<{id: number}>}
 * @throws {AppError} 403 sin una verificación vigente; 400 si el texto no es
 *   el vigente, si falta el representante de un menor de 14 o el canal; 409
 *   si ya está vigente.
 *
 * Consumidores: pacienteViewController (formulario de la ficha).
 */
async function otorgar({ pacienteId, finalidadClave, textoId, canal, representante }, solicitante) {
  validarCanal(canal);
  // En admisión el funcionario tiene el documento a la vista: no basta con
  // declarar la representación.
  if (canal === 'presencial' && representante && representante.documento === DECLARADA) {
    throw new AppError('En admisión la representación se acredita con un documento: indica cuál viste', 400);
  }
  const verificacion = await exigirVerificacion(pacienteId, solicitante.id, METODOS_CONSENTIMIENTO);
  return registrarOtorgamiento({ pacienteId, finalidadClave, textoId, canal, representante }, { usuarioId: solicitante.id, verificacionId: verificacion.id });
}

/**
 * Lo común a otorgar desde la ficha y desde el portal, una vez verificada la
 * identidad: el texto debe ser el vigente, no puede estar ya vigente y un
 * menor de 14 necesita a su representante.
 *
 * @param {{pacienteId: number, finalidadClave: string, textoId: number,
 *   canal: string, representante?: object}} datos
 * @param {{usuarioId: (number|null), verificacionId: number, actor?: string}} registro
 *   usuarioId null y actor 'titular' cuando lo hace el titular en el portal.
 * @returns {Promise<{id: number}>}
 *
 * Consumidores: otorgar(), portalService.otorgar.
 */
async function registrarOtorgamiento({ pacienteId, finalidadClave, textoId, canal, representante }, { usuarioId, verificacionId, actor = 'usuario' }) {
  const finalidad = await finalidadPorClave(finalidadClave);
  const [vigente] = finalidad.textos;
  if (Number(textoId) !== vigente.id) {
    throw new AppError('El texto aceptado no es la versión vigente: lee el texto actual antes de aceptarlo', 400);
  }

  const [estado] = (await estadoPorPaciente(pacienteId)).filter((e) => e.finalidad.clave === finalidadClave);
  if (estado.estado === 'vigente') throw new AppError('El consentimiento ya está vigente', 409);

  const edad = await pacienteService.edadDe(pacienteId);
  let representanteCifrado = null;
  if (requiereRepresentante(edad, finalidad)) {
    const { error, value } = representanteSchema.validate(representante || {});
    const motivo = edad < EDAD_CONSENTIMIENTO_PROPIO ? `es menor de ${EDAD_CONSENTIMIENTO_PROPIO} años` : `es menor de ${EDAD_SENSIBLES_PROPIO} años y este uso trata datos sensibles`;
    if (error) throw new AppError(`El titular ${motivo}: ${error.details[0].message}`, 400);
    representanteCifrado = cifrar('consentimiento.representante', JSON.stringify(value));
  }

  const fila = await prisma.consentimiento.create({
    data: {
      pacienteId,
      finalidadId: finalidad.id,
      textoId: vigente.id,
      canal,
      otorgadoPor: representanteCifrado ? 'representante' : 'titular',
      representanteCifrado,
      registradoPorId: usuarioId,
      verificacionId,
    },
  });
  await registrar({
    usuarioId,
    actor,
    accion: 'CONSENTIR',
    entidad: 'Paciente',
    entidadId: pacienteId,
    detalle: { finalidad: finalidadClave, version: vigente.version, consentimientoId: fila.id },
  });
  return { id: fila.id };
}

/**
 * Revoca el consentimiento de una finalidad: el mismo procedimiento que
 * otorgarlo. No borra el otorgamiento (queda como prueba); el tratamiento se
 * detiene desde este momento y lo hecho antes sigue siendo lícito.
 *
 * @param {{pacienteId: number, finalidadClave: string, canal: string}} datos
 * @param {{id: number}} solicitante - req.usuario.
 * @returns {Promise<number>} cuántos otorgamientos cerró: 0 si no había uno
 *   abierto (la vista no debe decir "revocado").
 * @throws {AppError} 403 sin una verificación vigente; 400 sin canal.
 *
 * Consumidores: pacienteViewController.revocarConsentimiento.
 */
async function revocar({ pacienteId, finalidadClave, canal }, solicitante) {
  validarCanal(canal);
  const verificacion = await exigirVerificacion(pacienteId, solicitante.id, METODOS_CONSENTIMIENTO);
  return revocarAbiertos(pacienteId, { finalidadClave, canal, usuarioId: solicitante.id, verificacionId: verificacion.id });
}

/**
 * Cierra los otorgamientos abiertos de un paciente (de una finalidad o de
 * todas) sin pedir una verificación nueva: la usa la ejecución de un derecho
 * que ya exigió la suya.
 *
 * @param {number} pacienteId
 * @param {{finalidadClave?: string, canal: string, usuarioId: (number|null),
 *   verificacionId: number, actor?: string}} datos - usuarioId null y actor
 *   'titular' cuando revoca el propio titular en el portal.
 * @param {object} [client] - prisma o la transacción en curso.
 * @returns {Promise<number>} cuántos se revocaron.
 *
 * Consumidores: revocar(), derechosService.ejecutar, portalService.revocar.
 */
async function revocarAbiertos(pacienteId, { finalidadClave, canal, usuarioId, verificacionId, actor = 'usuario' }, client = prisma) {
  const { count } = await client.consentimiento.updateMany({
    where: { pacienteId, revocadoEl: null, ...(finalidadClave ? { finalidad: { clave: finalidadClave } } : {}) },
    data: { revocadoEl: new Date(), revocacionCanal: canal, revocacionRegistradaPorId: usuarioId, revocacionVerificacionId: verificacionId },
  });
  if (count > 0) {
    await registrar(
      { usuarioId, actor, accion: 'REVOCAR', entidad: 'Paciente', entidadId: pacienteId, detalle: { finalidad: finalidadClave || 'todas', revocados: count } },
      client,
    );
  }
  return count;
}

/**
 * Si el paciente tiene vigente el consentimiento de una finalidad. Todo
 * proceso de esa finalidad debe preguntarlo justo antes de tratar el dato.
 *
 * @param {number} pacienteId
 * @param {string} finalidadClave
 * @returns {Promise<boolean>}
 *
 * Consumidores: recordatorioService, pacienteService (reporte de investigación).
 */
async function tieneVigente(pacienteId, finalidadClave) {
  const [estado] = (await estadoPorPaciente(pacienteId)).filter((e) => e.finalidad.clave === finalidadClave);
  return Boolean(estado) && estado.estado === 'vigente';
}

/**
 * Pacientes que tienen vigente el consentimiento de una finalidad: su último
 * otorgamiento no está revocado y es sobre el texto vigente. Lo consultan los
 * procesos de esa finalidad justo antes de tratar los datos.
 *
 * @param {string} finalidadClave
 * @returns {Promise<number[]>} ids de pacientes.
 *
 * Consumidores: recordatorioService, datosViewController (reporte de investigación).
 */
async function pacientesConVigente(finalidadClave) {
  const finalidad = await finalidadPorClave(finalidadClave);
  const [vigente] = finalidad.textos;
  // El último otorgamiento de cada paciente para esta finalidad.
  const ultimos = await prisma.consentimiento.findMany({
    where: { finalidadId: finalidad.id },
    distinct: ['pacienteId'],
    orderBy: [{ pacienteId: 'asc' }, { id: 'desc' }],
    select: { pacienteId: true, revocadoEl: true, textoId: true },
  });
  return ultimos.filter((c) => !c.revocadoEl && c.textoId === vigente.id).map((c) => c.pacienteId);
}

/**
 * Historial completo de consentimientos de un paciente: cada otorgamiento y,
 * si la hubo, su revocación, del más reciente al más antiguo. Del
 * representante solo la relación y el documento: su nombre y RUT no hacen
 * falta para seguir el historial.
 *
 * @param {number} pacienteId
 * @returns {Promise<Array<{finalidad: string, version: number, otorgadoEl: Date,
 *   canal: string, otorgadoPor: string, relacion: ?string, documento: ?string,
 *   metodoVerificacion: string, registradoPor: string, revocadoEl: ?Date,
 *   revocacionCanal: ?string, revocacionRegistradaPor: ?string}>>}
 *
 * Consumidores: pacienteViewController.detalle.
 */
async function historialPorPaciente(pacienteId) {
  const filas = await prisma.consentimiento.findMany({
    where: { pacienteId },
    orderBy: { id: 'desc' },
    select: {
      otorgadoEl: true,
      canal: true,
      otorgadoPor: true,
      representanteCifrado: true,
      revocadoEl: true,
      revocacionCanal: true,
      finalidad: { select: { nombre: true } },
      texto: { select: { version: true } },
      verificacion: { select: { metodo: true } },
      registradoPor: { select: { nombre: true } },
      revocacionRegistradaPor: { select: { nombre: true } },
    },
  });
  const enPortal = 'el titular, en el portal';
  return filas.map((f) => {
    const rep = f.representanteCifrado ? JSON.parse(descifrar('consentimiento.representante', f.representanteCifrado)) : null;
    return {
      finalidad: f.finalidad.nombre,
      version: f.texto.version,
      otorgadoEl: f.otorgadoEl,
      canal: f.canal,
      otorgadoPor: f.otorgadoPor,
      relacion: rep ? rep.relacion : null,
      // Los otorgados antes de exigir el documento no lo tienen.
      documento: rep ? rep.documento || DECLARADA : null,
      metodoVerificacion: f.verificacion.metodo,
      registradoPor: f.registradoPor ? f.registradoPor.nombre : enPortal,
      revocadoEl: f.revocadoEl,
      revocacionCanal: f.revocacionCanal,
      revocacionRegistradaPor: f.revocadoEl ? (f.revocacionRegistradaPor ? f.revocacionRegistradaPor.nombre : enPortal) : null,
    };
  });
}

module.exports = {
  CANALES,
  pacientesConVigente,
  RELACIONES,
  DOCUMENTOS_REPRESENTACION,
  DECLARADA,
  EDAD_CONSENTIMIENTO_PROPIO,
  EDAD_SENSIBLES_PROPIO,
  conRepresentante,
  historialPorPaciente,
  METODOS_CONSENTIMIENTO,
  requiereRepresentante,
  estadoPorPaciente,
  otorgar,
  revocar,
  revocarAbiertos,
  registrarOtorgamiento,
  tieneVigente,
};
