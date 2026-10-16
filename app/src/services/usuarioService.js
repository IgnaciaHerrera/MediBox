const { prisma } = require('../lib/prisma');
const { hashPassword } = require('./authService');
const { AppError } = require('../lib/AppError');
const { registrar } = require('./auditService');

const SELECT_SEGURO = { id: true, nombre: true, email: true, rolId: true, createdAt: true, rol: true };

async function listar() {
  return prisma.usuario.findMany({ select: SELECT_SEGURO, orderBy: { nombre: 'asc' } });
}

async function obtenerPorId(id) {
  const usuario = await prisma.usuario.findUnique({ where: { id }, select: SELECT_SEGURO });
  if (!usuario) throw new AppError('Usuario no encontrado', 404);
  return usuario;
}

// El vínculo usuario↔médico se gestiona por completo desde aquí (no desde
// Médicos): libera cualquier perfil que este usuario tuviera vinculado antes
// (permite reasignar, desvincular, o limpiar automáticamente si el rol dejó
// de ser "medico") y, si corresponde, vincula el nuevo perfil elegido.
async function vincularMedico(tx, usuarioId, rolId, medicoId) {
  const rol = await tx.rol.findUnique({ where: { id: Number(rolId) } });
  const esMedico = !!(rol && rol.nombre === 'medico');

  await tx.medico.updateMany({ where: { usuarioId }, data: { usuarioId: null } });

  if (esMedico && medicoId) {
    const medico = await tx.medico.findUnique({ where: { id: Number(medicoId) } });
    if (!medico) throw new AppError('Perfil de médico no encontrado', 404);
    if (medico.usuarioId && medico.usuarioId !== usuarioId) {
      throw new AppError('Ese perfil de médico ya tiene una cuenta vinculada', 409);
    }
    await tx.medico.update({ where: { id: Number(medicoId) }, data: { usuarioId } });
  }
}

/**
 * Crea una cuenta y la audita: crear una cuenta con un rol es otra forma de
 * dar acceso, y el gestor debe poder verla en la auditoría.
 *
 * @param {{nombre: string, email: string, password: string, rolId: number, medicoId?: number}} datos
 * @param {number} solicitanteId - quien crea la cuenta.
 * @returns {Promise<object>} la cuenta sin su hash.
 * @throws {AppError} 409 si el correo ya existe.
 *
 * Consumidores: usuarioController.store, usuarioViewController.crear.
 */
async function crear({ nombre, email, password, rolId, medicoId }, solicitanteId) {
  const existente = await prisma.usuario.findUnique({ where: { email } });
  if (existente) throw new AppError('Ya existe una cuenta con ese correo', 409);

  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async (tx) => {
    const usuarioNuevo = await tx.usuario.create({
      data: { nombre, email, passwordHash, rolId },
      select: SELECT_SEGURO,
    });
    await vincularMedico(tx, usuarioNuevo.id, rolId, medicoId);
    await registrar({ usuarioId: solicitanteId, accion: 'CREATE', entidad: 'Usuario', entidadId: usuarioNuevo.id }, tx);
    return usuarioNuevo;
  });
}

async function actualizar(id, opciones, solicitanteId) {
  const { nombre, rolId } = opciones;
  const actual = await obtenerPorId(id);
  if (solicitanteId === id && Number(rolId) !== actual.rolId) {
    throw new AppError('No puedes cambiar tu propio rol', 400);
  }
  // `medicoId` solo se aplica si el llamador lo incluyó explícitamente (aun
  // como `undefined`): la vista de Usuarios siempre lo incluye, así que cada
  // guardado ahí revalida el vínculo completo (reasignar/desvincular/limpiar
  // por cambio de rol). La API JSON de bajo nivel no lo declara en su
  // esquema, así que nunca llega aquí y el vínculo existente queda intacto.
  const gestionaVinculo = Object.prototype.hasOwnProperty.call(opciones, 'medicoId');
  return prisma.$transaction(async (tx) => {
    const usuarioActualizado = await tx.usuario.update({ where: { id }, data: { nombre, rolId }, select: SELECT_SEGURO });
    if (gestionaVinculo) await vincularMedico(tx, id, rolId, opciones.medicoId);
    // Un cambio de rol se distingue en la auditoría: es un cambio de acceso.
    const accion = Number(rolId) === actual.rolId ? 'UPDATE' : 'UPDATE_ROL';
    await registrar({ usuarioId: solicitanteId, accion, entidad: 'Usuario', entidadId: id }, tx);
    return usuarioActualizado;
  });
}

/**
 * Cambia la contraseña de una cuenta y lo audita (sin la contraseña).
 *
 * @param {number} id - cuenta a cambiar.
 * @param {string} nuevaPassword
 * @param {number} solicitanteId - quien hace el cambio.
 * @returns {Promise<void>}
 *
 * Consumidores: usuarioViewController.editar.
 */
async function cambiarPassword(id, nuevaPassword, solicitanteId) {
  await obtenerPorId(id);
  const passwordHash = await hashPassword(nuevaPassword);
  await prisma.$transaction(async (tx) => {
    await tx.usuario.update({ where: { id }, data: { passwordHash } });
    await registrar({ usuarioId: solicitanteId, accion: 'UPDATE_PASSWORD', entidad: 'Usuario', entidadId: id }, tx);
  });
}

async function listarPorRolNombre(rolNombre) {
  return prisma.usuario.findMany({
    where: { rol: { nombre: rolNombre } },
    select: SELECT_SEGURO,
    orderBy: { nombre: 'asc' },
  });
}

async function contar() {
  return prisma.usuario.count();
}

module.exports = { listar, obtenerPorId, crear, actualizar, cambiarPassword, listarPorRolNombre, contar };
