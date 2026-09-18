const bcrypt = require('bcrypt');
const { prisma } = require('../lib/prisma');

const SALT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

async function autenticar(email, password) {
  const usuario = await prisma.usuario.findUnique({ where: { email } });
  if (!usuario) return null;

  const passwordValida = await verifyPassword(password, usuario.passwordHash);
  if (!passwordValida) return null;

  return { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rolId: usuario.rolId };
}

module.exports = { hashPassword, verifyPassword, autenticar };
