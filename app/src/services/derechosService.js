const Joi = require('joi');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');
const { cifrar, descifrar } = require('../lib/cifrado');
const { TRATAMIENTO } = require('../lib/tratamiento');
const { normalizarRut, rutValido } = require('../lib/rut');
const { registrar } = require('./auditService');
const pacienteService = require('./pacienteService');
const citaService = require('./citaService');
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

// --- Gestión (rol privacidad) ------------------------------------------------

// Por qué un paciente está bloqueado, según la solicitud que lo originó.
const MOTIVOS_BLOQUEO = {
  supresion: 'Supresión: se eliminó su contacto y sus consentimientos; los datos clínicos se conservan bloqueados porque la Ley 20.584, art. 13, obliga a conservar la ficha clínica.',
  bloqueo: 'Bloqueo a pedido del titular: los datos se conservan, pero no se usan mientras se aclara la situación.',
};

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
}

async function cerrar(solicitud, solicitante, { estado, respuesta, entrega }, client = prisma) {
  await client.solicitudDerecho.update({
    where: { id: solicitud.id },
    data: { estado, respuestaCifrada: cifrar('solicitud.respuesta', respuesta), resueltaEl: new Date(), resueltaPorId: solicitante.id, ...(entrega ? { entrega } : {}) },
  });
  await registrar(
    {
      usuarioId: solicitante.id,
      accion: estado === 'resuelta' ? 'EJECUTAR_DERECHO' : 'RECHAZAR_DERECHO',
      entidad: 'Paciente',
      entidadId: solicitud.pacienteId,
      detalle: { solicitudId: solicitud.id, derecho: solicitud.derecho },
    },
    client,
  );
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
    select: { id: true, pacienteId: true, derecho: true, estado: true, canal: true, recibidaEl: true, venceEl: true, metodoVerificacion: true },
  });
  const nombres = filas.length ? await pacienteService.nombresDe([...new Set(filas.map((f) => f.pacienteId))], solicitante.id) : new Map();
  return filas.map((f) => ({ ...f, paciente: nombres.get(f.pacienteId), dentroDePlazo: new Date() <= f.venceEl, pendienteDeVerificacion: f.estado === 'recibida' }));
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
  const paciente = await pacienteService.obtenerFichaParaGestion(solicitud.pacienteId, solicitante, { solicitudId });
  return {
    solicitud: {
      ...solicitud,
      valorPropuesto: solicitud.valorPropuestoCifrado ? descifrar(`solicitud.valor.${solicitud.campo}`, solicitud.valorPropuestoCifrado) : null,
      respuesta: solicitud.respuestaCifrada ? descifrar('solicitud.respuesta', solicitud.respuestaCifrada) : null,
      metodosAceptados: METODOS_POR_DERECHO[solicitud.derecho],
    },
    paciente: { ...paciente, motivoBloqueo: paciente.bloqueado ? await motivoBloqueoDe(solicitud.pacienteId) : null },
    consentimientos: await consentimientoService.estadoPorPaciente(solicitud.pacienteId),
    historial: await pacienteService.listarHistorial(solicitud.pacienteId),
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

  if (solicitud.derecho === 'rectificacion') {
      const actual = await pacienteService.datosParaTitular(pacienteId);
    const valor = descifrar(`solicitud.valor.${solicitud.campo}`, solicitud.valorPropuestoCifrado);
    await pacienteService.actualizarPaciente(pacienteId, { ...actual, [solicitud.campo]: valor }, solicitante.id, { solicitudId });
    await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta });
    return;
  }

  if (solicitud.derecho === 'oposicion') {
    await consentimientoService.revocarAbiertos(pacienteId, { finalidadClave: solicitud.finalidadClave, canal: solicitud.canal, usuarioId: solicitante.id, verificacionId: solicitud.verificacionId });
    await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta });
    return;
  }

  // Supresión y bloqueo: lo que la ley no obliga a conservar se elimina de
  // verdad; lo clínico se conserva bloqueado. Todo o nada.
  await prisma.$transaction(async (tx) => {
    if (solicitud.derecho === 'supresion') {
      await pacienteService.suprimirContacto(pacienteId, marca, tx);
      await consentimientoService.revocarAbiertos(pacienteId, { canal: solicitud.canal, usuarioId: solicitante.id, verificacionId: solicitud.verificacionId }, tx);
      await tx.consentimiento.updateMany({ where: { pacienteId, representanteCifrado: { not: null } }, data: { representanteCifrado: null } });
    }
    await pacienteService.cambiarBloqueo(pacienteId, true, marca, tx);
    await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta }, tx);
  });

  // Un paciente bloqueado no se atiende con lo agendado: se anulan sus citas
  // futuras (cada una auditada y avisada al médico, como cualquier anulación).
  for (const citaId of await citaService.futurasDe(pacienteId)) {
    await citaService.anularCita(citaId, solicitante.id);
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
 * cuando se aclaró la situación. Un bloqueo por supresión no se levanta.
 *
 * @param {number} solicitudId - la solicitud de bloqueo.
 * @param {{id: number}} solicitante - req.usuario.
 * @returns {Promise<void>}
 * @throws {AppError} 409 si la solicitud no es un bloqueo resuelto.
 *
 * Consumidores: solicitudViewController.desbloquear.
 */
async function desbloquear(solicitudId, solicitante) {
  const solicitud = await solicitudOError(solicitudId);
  if (solicitud.derecho !== 'bloqueo' || solicitud.estado !== 'resuelta') {
    throw new AppError('Solo se levanta un bloqueo que se pidió como bloqueo y ya se resolvió', 409);
  }
  await pacienteService.cambiarBloqueo(solicitud.pacienteId, false, { usuarioId: solicitante.id, solicitudId });
}

// Rol del funcionario que aparece en "quién accedió a sus datos": el titular
// sabe qué función accedió, sin el nombre del funcionario (dato de otra persona).
const ETIQUETA_ROL = { operador: 'Admisión', medico: 'Médico tratante', gestor: 'Gestión', privacidad: 'Protección de datos', consulta: 'Informaciones', admin: 'Administración' };

/**
 * Genera el archivo del titular para el acceso o la portabilidad: un JSON
 * con todos sus datos y nada de otras personas ni datos internos (ids,
 * hashes o blobs). Marca la solicitud como resuelta con su entrega.
 *
 * @param {number} solicitudId
 * @param {{id: number}} solicitante - req.usuario.
 * @param {{entrega: ('contacto_registrado'|'presencial')}} opciones - nunca
 *   el canal por el que llamaron: en persona o al contacto ya registrado.
 * @returns {Promise<object>}
 * @throws {AppError} 409 si no es acceso o portabilidad, si no está
 *   verificada, o si el contacto falta o cambió después de la solicitud.
 *
 * Consumidores: solicitudViewController.descargar.
 */
async function exportarDatosTitular(solicitudId, solicitante, { entrega }) {
  const solicitud = await solicitudOError(solicitudId);
  if (solicitud.derecho !== 'acceso' && solicitud.derecho !== 'portabilidad') throw new AppError('Esta solicitud no es de acceso ni de portabilidad', 409);
  exigirVerificada(solicitud);
  if (!['contacto_registrado', 'presencial'].includes(entrega)) throw new AppError('Indica cómo se entrega: en persona o al contacto registrado', 400);

  const { pacienteId } = solicitud;
  const titular = await pacienteService.datosParaTitular(pacienteId);
  if (entrega === 'contacto_registrado') {
    const cambio = await pacienteService.ultimoCambioDe(pacienteId, 'contacto');
    if (!titular.contacto || (cambio && cambio >= solicitud.recibidaEl)) {
      throw new AppError('El contacto falta o cambió después de la solicitud: entrega el archivo en persona', 409);
    }
  }

  const [citas, consentimientos, solicitudes, historial, accesos] = await Promise.all([
    citaService.listarParaTitular(pacienteId),
    prisma.consentimiento.findMany({
      where: { pacienteId },
      orderBy: { otorgadoEl: 'asc' },
      select: { otorgadoEl: true, revocadoEl: true, canal: true, revocacionCanal: true, otorgadoPor: true, representanteCifrado: true, finalidad: { select: { nombre: true } }, texto: { select: { version: true, texto: true } } },
    }),
    prisma.solicitudDerecho.findMany({ where: { pacienteId }, orderBy: { recibidaEl: 'asc' }, select: { derecho: true, estado: true, canal: true, recibidaEl: true, resueltaEl: true } }),
    pacienteService.listarHistorial(pacienteId),
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
    solicitudes,
    historialCambios: historial.map((h) => ({ campo: h.campo, cambiadoEl: h.cambiadoEl })),
    accesos: accesos.map((a) => ({
      fecha: a.timestamp,
      accion: a.accion,
      resultado: a.resultado,
      rol: a.actor === 'sistema' ? 'Sistema' : ETIQUETA_ROL[a.usuario && a.usuario.rol.nombre] || 'Funcionario',
    })),
    tratamiento: TRATAMIENTO,
  };

  await prisma.$transaction(async (tx) => {
    await cerrar(solicitud, solicitante, { estado: 'resuelta', respuesta: `Se entregó una copia de sus datos (${entrega === 'presencial' ? 'en persona' : 'al contacto registrado'}).`, entrega }, tx);
    await registrar({ usuarioId: solicitante.id, accion: 'EXPORT_TITULAR', entidad: 'Paciente', entidadId: pacienteId, detalle: { solicitudId, entrega } }, tx);
  });
  return archivo;
}

module.exports = {
  DERECHOS,
  PLAZO_RESPUESTA_DIAS,
  METODOS_POR_DERECHO,
  registrarSolicitud,
  verificarSolicitud,
  listarPorPaciente,
  listarPendientes,
  obtenerParaGestion,
  ejecutar,
  rechazar,
  desbloquear,
  exportarDatosTitular,
};
