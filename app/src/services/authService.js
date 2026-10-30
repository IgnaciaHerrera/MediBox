const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { prisma } = require('../lib/prisma');
const { AppError } = require('../lib/AppError');

const SALT_ROUNDS = 12;
// bcrypt ignora en silencio todo lo que pase de 72 bytes: dos contraseñas que
// solo difieren después del byte 72 darían el mismo hash.
const BCRYPT_MAX_BYTES = 72;

/**
 * @param {string} password - contraseña en claro.
 * @returns {Promise<string>} hash bcrypt con sal propia y costo SALT_ROUNDS.
 * @throws {AppError} 400 si la contraseña supera los 72 bytes que bcrypt usa.
 *
 * Consumidores: usuarioService.crear(), usuarioService.cambiarPassword(),
 *   obtenerHashSimulado().
 */
async function hashPassword(password) {
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new AppError(`La contraseña no puede superar los ${BCRYPT_MAX_BYTES} bytes`, 400);
  }
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Hash de una contraseña aleatoria, calculado una vez y bajo demanda. Cuando
// el correo no existe se compara contra él, para que esa respuesta tarde lo
// mismo que una contraseña incorrecta: sin esto, un correo inexistente
// respondía en ~1 ms y uno registrado en ~280 ms, y se podía enumerar
// usuarios midiendo el tiempo del login.
let hashSimulado;
function obtenerHashSimulado() {
  hashSimulado = hashSimulado || hashPassword(crypto.randomBytes(16).toString('hex'));
  return hashSimulado;
}

async function autenticar(email, password) {
  const usuario = await prisma.usuario.findUnique({ where: { email } });
  const hash = usuario ? usuario.passwordHash : await obtenerHashSimulado();
  const passwordValida = await verifyPassword(password, hash);
  // Una cuenta suspendida (contención de un incidente) no entra aunque la
  // contraseña sea correcta, y responde igual que una incorrecta.
  if (!usuario || !passwordValida || usuario.suspendida) return null;

  return { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rolId: usuario.rolId };
}

/**
 * Id de la cuenta con ese correo, para auditar un login fallido a nombre de
 * la cuenta atacada. Se consulta en todo login fallido, exista o no la
 * cuenta, así que no agrega una diferencia de tiempo entre ambos casos.
 *
 * @param {string} email
 * @returns {Promise<(number|null)>}
 *
 * Consumidores: authController.login.
 */
async function buscarIdPorEmail(email) {
  const usuario = await prisma.usuario.findUnique({ where: { email }, select: { id: true } });
  return usuario ? usuario.id : null;
}

/**
 * Comprueba la contraseña de un usuario ya autenticado (reautenticación
 * antes de una acción sensible, como generar el archivo de un titular).
 *
 * @param {number} usuarioId
 * @param {string} password
 * @returns {Promise<boolean>}
 *
 * Consumidores: solicitudViewController.reautenticar.
 */
async function verificarContrasena(usuarioId, password) {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { passwordHash: true } });
  return Boolean(usuario) && verifyPassword(String(password || ''), usuario.passwordHash);
}

module.exports = { hashPassword, verifyPassword, autenticar, buscarIdPorEmail, verificarContrasena };
