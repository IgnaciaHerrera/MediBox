const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');
const { AppError } = require('../lib/AppError');
const { cifrar, descifrar, indiceCiego } = require('../lib/cifrado');
const { normalizarRut } = require('../lib/rut');

// Toda lectura de datos de paciente pasa por este servicio (con su propia
// auditoría), y es el único lugar donde se cifra y descifra.
//
// El resumen (listados, combobox de agenda) no incluye el RUT: quien solo
// navega la lista no necesita descifrar datos de identidad. El motivo de
// consulta vive en cada cita (citaService), no en el paciente.
const SELECT_RESUMEN = { id: true, nombreCifrado: true, contactoCifrado: true, fechaNacimiento: true, createdAt: true };
const SELECT_FICHA = { ...SELECT_RESUMEN, rutCifrado: true };

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
 * @param {{nombre: string, rut: string, contacto: string, motivoConsulta?: string}} datos
 *   motivoConsulta solo lo pasa prisma/migrar-cifrado.js, que llena la columna
 *   de legado del paciente; la aplicación guarda el motivo en cada cita.
 * @returns {{nombreCifrado: Buffer, rutCifrado: Buffer, rutIndice: Buffer,
 *   contactoCifrado: Buffer, motivoConsultaCifrado?: Buffer}}
 *
 * Consumidores: crearPaciente(), actualizarPaciente(), prisma/seed.js,
 *   prisma/migrar-cifrado.js.
 */
function cifrarPaciente({ nombre, rut, contacto, motivoConsulta }) {
  return {
    nombreCifrado: cifrar('paciente.nombre', nombre),
    rutCifrado: cifrar('paciente.rut', normalizarRut(rut)),
    rutIndice: indiceRut(rut),
    contactoCifrado: cifrar('paciente.contacto', contacto),
    ...(motivoConsulta === undefined ? {} : { motivoConsultaCifrado: cifrar('paciente.motivoConsulta', motivoConsulta) }),
  };
}

function resumen(fila) {
  return {
    id: fila.id,
    nombre: descifrar('paciente.nombre', fila.nombreCifrado),
    contacto: descifrar('paciente.contacto', fila.contactoCifrado),
    fechaNacimiento: fila.fechaNacimiento,
    createdAt: fila.createdAt,
  };
}

function ficha(fila) {
  return {
    ...resumen(fila),
    rut: descifrar('paciente.rut', fila.rutCifrado),
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

function sinTildes(texto) {
  return texto.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// ponytail: descifra los nombres en memoria para buscar, porque AES-GCM no
// admite LIKE en la base. Con miles de pacientes son milisegundos; si el
// padrón llega a cientos de miles, el upgrade es un índice ciego por tokens
// del nombre normalizado. Solo se descifra el contacto de las coincidencias.
async function buscarPorNombre(texto) {
  const aguja = sinTildes(texto);
  const filas = await prisma.paciente.findMany({ select: SELECT_RESUMEN, orderBy: { createdAt: 'desc' } });
  return filas.filter((fila) => sinTildes(descifrar('paciente.nombre', fila.nombreCifrado)).includes(aguja)).map(resumen);
}

// Un texto con forma de RUT (solo dígitos, puntos, guion y K) se busca por el
// índice ciego; cualquier otro, por nombre. Se mira la forma y no el dígito
// verificador porque hay pacientes migrados con RUT anteriores a esa
// validación, y un nombre nunca contiene dígitos.
const FORMA_DE_RUT = /^[\d.\s]+-?[\dkK]$/;

// Búsqueda exacta por el índice ciego: la base compara HMACs y nunca ve el
// RUT. Usa el índice único, así que no recorre la tabla.
async function buscarPorRut(rut) {
  const fila = await prisma.paciente.findUnique({ where: { rutIndice: indiceRut(rut) }, select: SELECT_RESUMEN });
  return fila ? [resumen(fila)] : [];
}

async function crearPaciente(datos, usuarioId) {
  return prisma
    .$transaction(async (tx) => {
      const fila = await tx.paciente.create({
        data: { ...cifrarPaciente(datos), fechaNacimiento: new Date(datos.fechaNacimiento) },
        select: SELECT_RESUMEN,
      });
      await registrar({ usuarioId, accion: 'CREATE', entidad: 'Paciente', entidadId: fila.id }, tx);
      return resumen(fila);
    })
    .catch(traducirErrorPrisma);
}

async function obtenerPacientePorId(id, usuarioId) {
  const fila = await prisma.paciente.findUnique({ where: { id }, select: SELECT_FICHA });
  if (!fila) throw new AppError('Paciente no encontrado', 404);

  await registrar({ usuarioId, accion: 'READ', entidad: 'Paciente', entidadId: id });
  return ficha(fila);
}

async function actualizarPaciente(id, datos, usuarioId) {
  return prisma
    .$transaction(async (tx) => {
      const fila = await tx.paciente.update({
        where: { id },
        data: { ...cifrarPaciente(datos), fechaNacimiento: new Date(datos.fechaNacimiento) },
        select: SELECT_RESUMEN,
      });
      await registrar({ usuarioId, accion: 'UPDATE', entidad: 'Paciente', entidadId: id }, tx);
      return resumen(fila);
    })
    .catch(traducirErrorPrisma);
}

async function listarPacientes({ page = 1, pageSize = 20, q } = {}, usuarioId) {
  const busqueda = (q || '').trim();
  let items;
  let total;

  if (busqueda) {
    const coincidencias = FORMA_DE_RUT.test(busqueda) ? await buscarPorRut(busqueda) : await buscarPorNombre(busqueda);
    total = coincidencias.length;
    items = coincidencias.slice((page - 1) * pageSize, page * pageSize);
  } else {
    const [filas, cantidad] = await Promise.all([
      prisma.paciente.findMany({
        select: SELECT_RESUMEN,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.paciente.count(),
    ]);
    items = filas.map(resumen);
    total = cantidad;
  }

  await registrar({ usuarioId, accion: 'LIST', entidad: 'Paciente', entidadId: 0 });
  return { items, total, page, pageSize };
}

async function listarTodosParaExport(usuarioId) {
  const filas = await prisma.paciente.findMany({ select: SELECT_FICHA, orderBy: { createdAt: 'desc' } });

  await registrar({ usuarioId, accion: 'EXPORT', entidad: 'Paciente', entidadId: 0 });
  return filas.map(ficha);
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
  listarPacientes,
  listarTodosParaExport,
  contar,
  cifrarPaciente,
};
