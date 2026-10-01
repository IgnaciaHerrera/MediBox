const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { prisma } = require('../lib/prisma');

const SALT_ROUNDS = 12;

async function hashPassword(password) {
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
  if (!usuario || !passwordValida) return null;

  return { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rolId: usuario.rolId };
}

module.exports = { hashPassword, verifyPassword, autenticar };
