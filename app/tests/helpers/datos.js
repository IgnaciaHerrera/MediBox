const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { prisma } = require('../../src/lib/prisma');
const { cifrarPaciente } = require('../../src/services/pacienteService');

/**
 * RUT con su dígito verificador correcto (la API lo valida).
 *
 * @param {number} numero - cuerpo del RUT, sin dígito verificador.
 * @returns {string} p. ej. "12345678-5".
 *
 * Consumidores: tests de integración del Hito 3.
 */
function rutConDv(numero) {
  let suma = 0;
  let factor = 2;
  for (const d of String(numero).split('').reverse()) {
    suma += Number(d) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  return `${numero}-${dv}`;
}

/**
 * RUT válido al azar en un rango (40 a 49 millones) que el seed no usa, para
 * que dos corridas o dos archivos no choquen con el índice único.
 *
 * @returns {string}
 */
function rutAleatorio() {
  return rutConDv(40000000 + crypto.randomInt(10000000));
}

/**
 * Usuario de prueba con un rol existente. Se reutiliza entre corridas
 * (upsert por correo) porque la auditoría, de solo inserción, lo referencia.
 *
 * @param {string} email
 * @param {string} rolNombre
 * @param {string} password
 * @returns {Promise<object>} el usuario.
 */
async function usuarioDePrueba(email, rolNombre, password) {
  const rol = await prisma.rol.findUniqueOrThrow({ where: { nombre: rolNombre } });
  return prisma.usuario.upsert({
    where: { email },
    update: { rolId: rol.id },
    create: { nombre: `Test ${email.split('@')[0]}`, email, passwordHash: await bcrypt.hash(password, 4), rolId: rol.id },
  });
}

/**
 * Paciente de prueba creado directo con Prisma, con sus datos cifrados.
 *
 * @param {object} [datos] - nombre, fechaNacimiento, contacto, createdAt.
 * @returns {Promise<object>} la fila creada.
 */
function pacienteDePrueba({ nombre = 'Paciente Prueba', fechaNacimiento = '1990-01-01', contacto, createdAt } = {}) {
  return prisma.paciente.create({
    data: { ...cifrarPaciente({ nombre, rut: rutAleatorio(), fechaNacimiento, contacto }), ...(createdAt ? { createdAt } : {}) },
  });
}

module.exports = { rutConDv, rutAleatorio, usuarioDePrueba, pacienteDePrueba };
