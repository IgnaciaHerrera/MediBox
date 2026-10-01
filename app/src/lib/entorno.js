const { revisarLlaves } = require('./cifrado');

const LARGO_MINIMO_SECRETO_SESION = 32;
const MARCADOR_DE_EJEMPLO = /change-me/i;

/**
 * Revisa que la configuración sensible esté completa y no sea la de ejemplo,
 * para que el servidor se niegue a arrancar antes de atender peticiones con
 * secretos débiles. Los mensajes nombran variables, nunca valores.
 *
 * @returns {string[]} problemas encontrados; vacío si se puede arrancar.
 *
 * Consumidores: src/server.js.
 */
function revisarEntorno() {
  const env = process.env;
  const problemas = [];

  if (!env.DATABASE_URL) {
    problemas.push('DATABASE_URL no está definida');
  } else if (env.NODE_ENV === 'production' && MARCADOR_DE_EJEMPLO.test(env.DATABASE_URL)) {
    problemas.push('DATABASE_URL usa la contraseña de ejemplo de .env.example');
  }

  const secretoSesion = env.SESSION_SECRET || '';
  if (secretoSesion.length < LARGO_MINIMO_SECRETO_SESION || MARCADOR_DE_EJEMPLO.test(secretoSesion)) {
    problemas.push(`SESSION_SECRET debe ser un valor aleatorio de al menos ${LARGO_MINIMO_SECRETO_SESION} caracteres`);
  }

  return [...problemas, ...revisarLlaves()];
}

module.exports = { revisarEntorno };
