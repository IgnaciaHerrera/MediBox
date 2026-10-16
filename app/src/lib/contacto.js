// Muestra un contacto del paciente sin revelarlo completo: lo necesario para
// que el funcionario y el titular confirmen a dónde va el código, y nada más.

const OCULTO = '•••';

/**
 * Enmascara un teléfono o un correo.
 *
 * @param {string} contacto - teléfono (p. ej. "+56911112222") o correo.
 * @returns {string} "+56 9 •••• 2222", "a•••@mail.cl" o "•••" si es demasiado
 *   corto para mostrar una parte.
 *
 * Consumidores: services/verificacionService.js, vistas de la ficha.
 */
function enmascararContacto(contacto) {
  const texto = String(contacto || '').trim();
  if (texto.includes('@')) {
    const [usuario, dominio] = texto.split('@');
    return `${usuario.slice(0, 1)}${OCULTO}@${dominio}`;
  }
  const digitos = texto.replace(/\D/g, '');
  if (digitos.length < 8) return OCULTO;
  // Celular chileno: +56 9 XXXX XXXX. Se deja ver el prefijo y los últimos 4.
  if (digitos.startsWith('569') && digitos.length === 11) return `+56 9 •••• ${digitos.slice(-4)}`;
  return `${OCULTO} ${digitos.slice(-4)}`;
}

module.exports = { enmascararContacto };
