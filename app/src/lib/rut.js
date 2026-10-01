// RUT chileno: normalización y dígito verificador (módulo 11). Es la misma
// regla que aplica public/js/pacientes-formulario.js en el navegador, pero
// aquí es la que vale: el servidor no confía en la validación del cliente.

/**
 * Lleva un RUT a su forma canónica "CUERPO-DV": sin puntos ni espacios, sin
 * ceros a la izquierda y con la K en mayúscula. Dos formas de escribir el
 * mismo RUT deben dar el mismo resultado, porque el índice ciego se calcula
 * sobre esta forma.
 *
 * @param {string} valor - RUT tal como lo escribió el usuario.
 * @returns {string} p. ej. '12.345.678-k' -> '12345678-K'.
 *
 * Consumidores: rutValido(), controllers de paciente (vía Joi), pacienteService.
 */
function normalizarRut(valor) {
  const limpio = String(valor).replace(/[.\s-]/g, '').toUpperCase();
  const cuerpo = limpio.slice(0, -1).replace(/^0+/, '');
  return `${cuerpo}-${limpio.slice(-1)}`;
}

function calcularDv(cuerpo) {
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i -= 1) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

/**
 * @param {string} valor - RUT en cualquier formato.
 * @returns {boolean} true si el cuerpo es numérico (hasta 8 dígitos) y el
 *   dígito verificador corresponde.
 *
 * Consumidores: controllers de paciente (vía Joi), pacienteService (búsqueda).
 */
function rutValido(valor) {
  const [cuerpo, dv] = normalizarRut(valor).split('-');
  return /^[1-9]\d{0,7}$/.test(cuerpo) && calcularDv(cuerpo) === dv;
}

module.exports = { normalizarRut, rutValido };
