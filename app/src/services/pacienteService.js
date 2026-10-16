const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');
const { AppError } = require('../lib/AppError');
const { cifrar, descifrar, indiceCiego } = require('../lib/cifrado');
const { normalizarRut } = require('../lib/rut');
const { edadEnAnios } = require('../lib/fecha');

// Tramos de edad de la exportación seudonimizada. El último queda abierto
// ("80+"): las edades extremas son pocas y por sí solas identifican.
const TRAMO_EDAD_ANIOS = 10;
const EDAD_TRAMO_ABIERTO = 80;

// Toda lectura de datos de paciente pasa por este servicio (con su propia
// auditoría), y es el único lugar donde se cifra y descifra.
//
// El resumen (listados, combobox de agenda) trae solo lo necesario para
// reconocer al paciente: nombre y edad. El RUT, la fecha exacta y el contacto
// se descifran únicamente al abrir la ficha. El motivo de consulta vive en
// cada cita (citaService), no en el paciente.
const SELECT_RESUMEN = { id: true, nombreCifrado: true, fechaNacimientoCifrada: true, createdAt: true };
const SELECT_FICHA = { ...SELECT_RESUMEN, rutCifrado: true, contactoCifrado: true };

/**
 * Indica si un usuario puede leer pacientes, sea a todos o solo a los suyos.
 *
 * @param {{permisos: string[]}} solicitante - req.usuario.
 * @returns {boolean}
 *
 * Consumidores: alcanceDe(), agendaViewController.detalle, topbar.
 */
function puedeLeerPacientes(solicitante) {
  return solicitante.permisos.includes('paciente.read') || solicitante.permisos.includes('paciente.read.propios');
}

/**
 * Filtro de Prisma con los pacientes que un usuario puede leer. Con
 * 'paciente.read' son todos; con 'paciente.read.propios' (el médico) solo los
 * que tienen o tuvieron una cita con él: la Ley 20.584, art. 13, deja fuera
 * de la ficha a quien no participa en la atención. Un paciente fuera del
 * alcance se responde como inexistente (404), sin revelar que existe.
 *
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {object} cláusula `where` para prisma.paciente.
 * @throws {AppError} 403 si no tiene ninguno de los dos permisos.
 *
 * Consumidores: listarPacientes(), obtenerPacientePorId(), buscarPorNombre(),
 *   buscarPorRut().
 */
function alcanceDe(solicitante) {
  if (solicitante.permisos.includes('paciente.read')) return {};
  if (puedeLeerPacientes(solicitante)) return { citas: { some: { medico: { usuarioId: solicitante.id } } } };
  throw new AppError('Permiso insuficiente', 403);
}

/**
 * Índice ciego del RUT: HMAC-SHA256 de su forma canónica.
 *
 * @param {string} rut - RUT en cualquier formato.
 * @returns {Buffer} valor de la columna rut_indice.
 *
 * Consumidores: cifrarPaciente(), buscarPorRut().
 */
function indiceRut(rut) {
  return indiceCiego('paciente.rut', normalizarRut(rut));
}

/**
 * Convierte los datos en claro de un paciente en las columnas cifradas.
 *
 * @param {{nombre: string, rut: string, fechaNacimiento?: (Date|string),
 *   contacto?: string, motivoConsulta?: string}} datos
 *   fechaNacimiento es obligatoria para la aplicación; solo
 *   prisma/migrar-cifrado.js la omite, porque recifra una base anterior que
 *   aún la guardaba en claro. contacto es opcional. motivoConsulta solo lo
 *   pasa ese mismo script, que llena la columna de legado del paciente.
 * @returns {{nombreCifrado: Buffer, rutCifrado: Buffer, rutIndice: Buffer,
 *   contactoCifrado: (Buffer|null), fechaNacimientoCifrada?: Buffer,
 *   motivoConsultaCifrado?: Buffer}}
 *
 * Consumidores: crearPaciente(), actualizarPaciente(), prisma/seed.js,
 *   prisma/migrar-cifrado.js, tests de integración.
 */
function cifrarPaciente({ nombre, rut, fechaNacimiento, contacto, motivoConsulta }) {
  return {
    nombreCifrado: cifrar('paciente.nombre', nombre),
    rutCifrado: cifrar('paciente.rut', normalizarRut(rut)),
    rutIndice: indiceRut(rut),
    contactoCifrado: contacto ? cifrar('paciente.contacto', contacto) : null,
    ...(fechaNacimiento === undefined
      ? {}
      : { fechaNacimientoCifrada: cifrar('paciente.fechaNacimiento', new Date(fechaNacimiento).toISOString().slice(0, 10)) }),
    ...(motivoConsulta === undefined ? {} : { motivoConsultaCifrado: cifrar('paciente.motivoConsulta', motivoConsulta) }),
  };
}

function resumen(fila) {
  return {
    id: fila.id,
    nombre: descifrar('paciente.nombre', fila.nombreCifrado),
    edad: edadEnAnios(descifrar('paciente.fechaNacimiento', fila.fechaNacimientoCifrada)),
    createdAt: fila.createdAt,
  };
}

function ficha(fila) {
  return {
    ...resumen(fila),
    rut: descifrar('paciente.rut', fila.rutCifrado),
    fechaNacimiento: descifrar('paciente.fechaNacimiento', fila.fechaNacimientoCifrada),
    contacto: fila.contactoCifrado ? descifrar('paciente.contacto', fila.contactoCifrado) : null,
  };
}

// La única restricción única de la tabla es rut_indice, y P2025 solo puede
// venir del update de un id inexistente.
function traducirErrorPrisma(err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') throw new AppError('Ya existe un paciente registrado con ese RUT', 409);
    if (err.code === 'P2025') throw new AppError('Paciente no encontrado', 404);
  }
  throw err;
}

/**
 * Seudónimo estable de un paciente para los datos que salen del sistema:
 * HMAC-SHA256 de su id con PACIENTE_SEUDONIMO_KEY, truncado a 64 bits. El
 * mismo paciente tiene el mismo seudónimo en todas las exportaciones (permite
 * seguirlo en el tiempo y cruzar citas con auditoría) y solo quien tenga la
 * llave y la base puede volver a identificarlo. No es anonimización: el
 * archivo sigue conteniendo datos personales.
 *
 * @param {number} pacienteId
 * @returns {string} p. ej. "P-3F9A0C1D2E4B5A67".
 *
 * Consumidores: listarSeudonimizadoParaExport(), datosViewController
 *   (exportaciones de citas y auditoría).
 */
function seudonimo(pacienteId) {
  return `P-${indiceCiego('paciente.seudonimo', String(pacienteId)).toString('hex').slice(0, 16).toUpperCase()}`;
}

/**
 * Generaliza una edad a su tramo de diez años ("30-39"), con un último tramo
 * abierto ("80+").
 *
 * @param {number} edad - años cumplidos.
 * @returns {string}
 *
 * Consumidores: listarSeudonimizadoParaExport().
 */
function tramoEtario(edad) {
  if (edad >= EDAD_TRAMO_ABIERTO) return `${EDAD_TRAMO_ABIERTO}+`;
  const desde = Math.floor(edad / TRAMO_EDAD_ANIOS) * TRAMO_EDAD_ANIOS;
  return `${desde}-${desde + TRAMO_EDAD_ANIOS - 1}`;
}

function sinTildes(texto) {
  return texto.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// ponytail: descifra los nombres en memoria para buscar, porque AES-GCM no
// admite LIKE en la base. Con miles de pacientes son milisegundos; si el
// padrón llega a cientos de miles, el upgrade es un índice ciego por tokens
// del nombre normalizado. Solo se descifra la fecha de las coincidencias.
async function buscarPorNombre(texto, alcance) {
  const aguja = sinTildes(texto);
  const filas = await prisma.paciente.findMany({ where: alcance, select: SELECT_RESUMEN, orderBy: { createdAt: 'desc' } });
  return filas.filter((fila) => sinTildes(descifrar('paciente.nombre', fila.nombreCifrado)).includes(aguja)).map(resumen);
}

// Un texto con forma de RUT (solo dígitos, puntos, guion y K) se busca por el
// índice ciego; cualquier otro, por nombre. Se mira la forma y no el dígito
// verificador porque hay pacientes migrados con RUT anteriores a esa
// validación, y un nombre nunca contiene dígitos.
const FORMA_DE_RUT = /^[\d.\s]+-?[\dkK]$/;

// Búsqueda exacta por el índice ciego: la base compara HMACs y nunca ve el
// RUT. Usa el índice único, así que no recorre la tabla.
async function buscarPorRut(rut, alcance) {
  const fila = await prisma.paciente.findFirst({ where: { rutIndice: indiceRut(rut), ...alcance }, select: SELECT_RESUMEN });
  return fila ? [resumen(fila)] : [];
}

async function crearPaciente(datos, usuarioId) {
  return prisma
    .$transaction(async (tx) => {
      const fila = await tx.paciente.create({
        data: cifrarPaciente(datos),
        select: SELECT_RESUMEN,
      });
      await registrar({ usuarioId, accion: 'CREATE', entidad: 'Paciente', entidadId: fila.id }, tx);
      return resumen(fila);
    })
    .catch(traducirErrorPrisma);
}

/**
 * Ficha completa de un paciente (descifrada), dentro del alcance de quien la
 * pide. Cada lectura queda auditada.
 *
 * @param {number} id - id del paciente.
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {Promise<object>} ficha con rut, fecha de nacimiento y contacto.
 * @throws {AppError} 404 si no existe o está fuera de su alcance. Si existe
 *   pero está fuera del alcance, el intento queda auditado como 'denegado'
 *   (solo internamente: la respuesta sigue sin revelar que existe).
 *
 * Consumidores: pacienteController.show, pacienteViewController.detalle y
 *   editarForm, agendaViewController.detalle.
 */
async function obtenerPacientePorId(id, solicitante) {
  const fila = await prisma.paciente.findFirst({ where: { id, ...alcanceDe(solicitante) }, select: SELECT_FICHA });
  if (!fila) {
    if (await prisma.paciente.findUnique({ where: { id }, select: { id: true } })) {
      await registrar({ usuarioId: solicitante.id, accion: 'READ', entidad: 'Paciente', entidadId: id, resultado: 'denegado' });
    }
    throw new AppError('Paciente no encontrado', 404);
  }

  await registrar({ usuarioId: solicitante.id, accion: 'READ', entidad: 'Paciente', entidadId: id });
  return ficha(fila);
}

// Campos rectificables, en la forma en que se comparan: el RUT normalizado,
// la fecha como AAAA-MM-DD y el contacto vacío como null.
const CAMPOS_RECTIFICABLES = ['nombre', 'rut', 'fechaNacimiento', 'contacto'];

function valoresComparables({ nombre, rut, fechaNacimiento, contacto }) {
  return {
    nombre,
    rut: normalizarRut(rut),
    fechaNacimiento: new Date(fechaNacimiento).toISOString().slice(0, 10),
    contacto: contacto || null,
  };
}

/**
 * Actualiza un paciente y deja en historial_cambios, por cada campo que
 * cambió, el valor anterior cifrado con la llave de su categoría, quién y
 * cuándo. Todo en una transacción: si falla el historial, no cambia nada.
 *
 * @param {number} id - id del paciente.
 * @param {{nombre: string, rut: string, fechaNacimiento: (Date|string), contacto?: string}} datos
 * @param {number} usuarioId - quien edita.
 * @param {{solicitudId?: number}} [opciones] - la solicitud de rectificación
 *   que origina el cambio, si la hay.
 * @returns {Promise<object>} resumen del paciente.
 * @throws {AppError} 404 si no existe; 409 si el RUT ya es de otro paciente.
 *
 * Consumidores: pacienteController.update, pacienteViewController.editar,
 *   derechosService.ejecutar (rectificación).
 */
async function actualizarPaciente(id, datos, usuarioId, { solicitudId } = {}) {
  return prisma
    .$transaction(async (tx) => {
      const actual = await tx.paciente.findUnique({ where: { id }, select: SELECT_FICHA });
      if (!actual) throw new AppError('Paciente no encontrado', 404);

      const antes = valoresComparables(ficha(actual));
      const despues = valoresComparables(datos);
      const cambios = CAMPOS_RECTIFICABLES.filter((campo) => antes[campo] !== despues[campo]).map((campo) => ({
        pacienteId: id,
        campo,
        valorAnteriorCifrado: antes[campo] === null ? null : cifrar(`historial.${campo}`, antes[campo]),
        cambiadoPorId: usuarioId,
        solicitudId: solicitudId || null,
      }));

      const fila = await tx.paciente.update({ where: { id }, data: cifrarPaciente(datos), select: SELECT_RESUMEN });
      if (cambios.length > 0) await tx.historialCambio.createMany({ data: cambios });
      await registrar({ usuarioId, accion: 'UPDATE', entidad: 'Paciente', entidadId: id, detalle: { campos: cambios.map((c) => c.campo) } }, tx);
      return resumen(fila);
    })
    .catch(traducirErrorPrisma);
}

/**
 * Historial de cambios de un paciente, sin los valores: qué campo, cuándo y
 * quién. Lo muestra la ficha; los valores anteriores solo los entrega la
 * exportación al propio titular.
 *
 * @param {number} pacienteId
 * @returns {Promise<Array<{campo: string, cambiadoEl: Date, cambiadoPor: string}>>}
 *
 * Consumidores: pacienteViewController.detalle, derechosService.
 */
async function listarHistorial(pacienteId) {
  const filas = await prisma.historialCambio.findMany({
    where: { pacienteId },
    select: { campo: true, cambiadoEl: true, cambiadoPor: { select: { nombre: true } } },
    orderBy: { cambiadoEl: 'desc' },
  });
  return filas.map((f) => ({ campo: f.campo, cambiadoEl: f.cambiadoEl, cambiadoPor: f.cambiadoPor.nombre }));
}

/**
 * Exige que el paciente exista y esté en el alcance del solicitante, sin
 * leer ni auditar sus datos (no descifra nada).
 *
 * @param {number} pacienteId
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {Promise<void>}
 * @throws {AppError} 404 si no existe o está fuera de su alcance.
 *
 * Consumidores: verificacionService.verificarConCedula.
 */
async function exigirAlcance(pacienteId, solicitante) {
  const fila = await prisma.paciente.findFirst({ where: { id: pacienteId, ...alcanceDe(solicitante) }, select: { id: true } });
  if (!fila) throw new AppError('Paciente no encontrado', 404);
}

/**
 * Edad del paciente, para decidir si un consentimiento lo da su
 * representante. No se audita: es una validación interna que no muestra el
 * dato a nadie (como contar()).
 *
 * @param {number} pacienteId
 * @returns {Promise<number>} años cumplidos.
 * @throws {AppError} 404 si no existe.
 *
 * Consumidores: consentimientoService.otorgar, derechosService.
 */
async function edadDe(pacienteId) {
  const fila = await prisma.paciente.findUnique({ where: { id: pacienteId }, select: { fechaNacimientoCifrada: true } });
  if (!fila) throw new AppError('Paciente no encontrado', 404);
  return edadEnAnios(descifrar('paciente.fechaNacimiento', fila.fechaNacimientoCifrada));
}

/**
 * Contacto en claro del paciente, solo para enviarle un código de
 * verificación. La lectura queda auditada con su motivo.
 *
 * @param {number} pacienteId
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {Promise<{contacto: (string|null), createdAt: Date}>}
 * @throws {AppError} 404 si no existe o está fuera de su alcance.
 *
 * Consumidores: verificacionService.enviarCodigo.
 */
async function contactoParaVerificacion(pacienteId, solicitante) {
  const fila = await prisma.paciente.findFirst({
    where: { id: pacienteId, ...alcanceDe(solicitante) },
    select: { contactoCifrado: true, createdAt: true },
  });
  if (!fila) throw new AppError('Paciente no encontrado', 404);
  await registrar({ usuarioId: solicitante.id, accion: 'READ', entidad: 'Paciente', entidadId: pacienteId, detalle: { motivo: 'verificacion' } });
  return { contacto: fila.contactoCifrado ? descifrar('paciente.contacto', fila.contactoCifrado) : null, createdAt: fila.createdAt };
}

/**
 * Contactos en claro de varios pacientes, para un proceso del sistema que
 * ya comprobó el consentimiento de cada uno (recordatorios). No audita por
 * paciente: el proceso deja su propia fila con el conteo.
 *
 * @param {number[]} pacienteIds
 * @returns {Promise<Map<number, string>>} solo los que tienen contacto.
 *
 * Consumidores: recordatorioService.enviarRecordatorios.
 */
async function contactosParaProceso(pacienteIds) {
  const filas = await prisma.paciente.findMany({
    where: { id: { in: pacienteIds }, contactoCifrado: { not: null } },
    select: { id: true, contactoCifrado: true },
  });
  return new Map(filas.map((f) => [f.id, descifrar('paciente.contacto', f.contactoCifrado)]));
}

/**
 * Fecha del último cambio de un campo del paciente.
 *
 * @param {number} pacienteId
 * @param {string} campo - 'nombre' | 'rut' | 'fechaNacimiento' | 'contacto'.
 * @returns {Promise<(Date|null)>} null si nunca cambió.
 *
 * Consumidores: verificacionService.enviarCodigo (el código solo va a un
 *   contacto que no cambió recientemente).
 */
async function ultimoCambioDe(pacienteId, campo) {
  const fila = await prisma.historialCambio.findFirst({ where: { pacienteId, campo }, orderBy: { cambiadoEl: 'desc' }, select: { cambiadoEl: true } });
  return fila ? fila.cambiadoEl : null;
}

/**
 * Lista paginada (resumen: nombre y edad) de los pacientes que el usuario
 * puede leer, con búsqueda opcional por nombre o RUT completo. Se audita.
 *
 * @param {{page?: number, pageSize?: number, q?: string}} opciones
 * @param {{id: number, permisos: string[]}} solicitante - req.usuario.
 * @returns {Promise<{items: object[], total: number, page: number, pageSize: number}>}
 *
 * Consumidores: pacienteController.index, pacienteViewController.index,
 *   agendaViewController (selector de paciente al agendar).
 */
async function listarPacientes({ page = 1, pageSize = 20, q } = {}, solicitante) {
  const alcance = alcanceDe(solicitante);
  const busqueda = (q || '').trim();
  let items;
  let total;

  if (busqueda) {
    const coincidencias = FORMA_DE_RUT.test(busqueda)
      ? await buscarPorRut(busqueda, alcance)
      : await buscarPorNombre(busqueda, alcance);
    total = coincidencias.length;
    items = coincidencias.slice((page - 1) * pageSize, page * pageSize);
  } else {
    const [filas, cantidad] = await Promise.all([
      prisma.paciente.findMany({
        where: alcance,
        select: SELECT_RESUMEN,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.paciente.count({ where: alcance }),
    ]);
    items = filas.map(resumen);
    total = cantidad;
  }

  await registrar({ usuarioId: solicitante.id, accion: 'LIST', entidad: 'Paciente', entidadId: 0 });
  return { items, total, page, pageSize };
}

/**
 * Reporte de gestión de pacientes, seudonimizado: por cada paciente su
 * seudónimo, su tramo de edad, el año en que se registró y cuántas citas
 * (no anuladas) tiene. Sin nombre, RUT, fecha exacta ni contacto: un reporte
 * de gestión no los necesita (Hito 1, flujo F4). Se audita.
 *
 * @param {number} usuarioId - quien exporta.
 * @param {{pacienteIds?: number[], finalidad?: string}} [opciones] - para el
 *   reporte de investigación: solo los pacientes con ese consentimiento
 *   vigente (la finalidad queda en la auditoría).
 * @returns {Promise<Array<{paciente: string, tramoEtario: string, anioRegistro: number, citas: number}>>}
 *
 * Consumidores: datosViewController.exportarPacientes y exportarInvestigacion.
 */
async function listarSeudonimizadoParaExport(usuarioId, { pacienteIds, finalidad } = {}) {
  const filas = await prisma.paciente.findMany({
    where: pacienteIds ? { id: { in: pacienteIds } } : {},
    select: { id: true, fechaNacimientoCifrada: true, createdAt: true, _count: { select: { citas: { where: { anulada: false } } } } },
    orderBy: { id: 'asc' },
  });

  await registrar({
    usuarioId,
    accion: 'EXPORT',
    entidad: finalidad ? 'Investigacion' : 'Paciente',
    entidadId: 0,
    ...(finalidad ? { detalle: { finalidad, pacientes: filas.length } } : {}),
  });
  return filas.map((fila) => ({
    paciente: seudonimo(fila.id),
    tramoEtario: tramoEtario(edadEnAnios(descifrar('paciente.fechaNacimiento', fila.fechaNacimientoCifrada))),
    anioRegistro: fila.createdAt.getFullYear(),
    citas: fila._count.citas,
  }));
}

// Sin auditar: es un conteo agregado, no expone la identidad de ningún
// paciente en particular (a diferencia de listarPacientes/obtenerPacientePorId).
async function contar() {
  return prisma.paciente.count();
}

module.exports = {
  crearPaciente,
  obtenerPacientePorId,
  actualizarPaciente,
  listarHistorial,
  ultimoCambioDe,
  exigirAlcance,
  edadDe,
  contactosParaProceso,
  contactoParaVerificacion,
  listarPacientes,
  listarSeudonimizadoParaExport,
  seudonimo,
  tramoEtario,
  contar,
  cifrarPaciente,
  puedeLeerPacientes,
};
