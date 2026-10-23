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

/**
 * Revisa con qué rol se conectó la aplicación a la base: no debe ser
 * superusuario ni dueño de las tablas, porque con esos privilegios podría
 * desactivar el trigger de solo inserción de la auditoría, borrar pacientes o
 * cambiar el esquema. Debe ser medibox_app (migración
 * 20261023120000_rol_aplicacion), y las migraciones las aplica el dueño.
 *
 * @param {import('@prisma/client').PrismaClient} prisma - cliente de la app.
 * @returns {Promise<string[]>} problemas encontrados; vacío si el rol es adecuado.
 *
 * Consumidores: src/server.js (solo en producción) y
 *   tests/integration/rol-aplicacion.test.js.
 */
async function revisarRolBase(prisma) {
  const [{ superusuario, duenoDeTablas }] = await prisma.$queryRaw`
    SELECT r.rolsuper AS superusuario,
           EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS "duenoDeTablas"
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (superusuario || duenoDeTablas) {
    return ['DATABASE_URL se conecta como superusuario o dueño de las tablas: la aplicación debe usar el rol medibox_app'];
  }
  return [];
}

module.exports = { revisarEntorno, revisarRolBase };
