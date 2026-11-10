const path = require('path');
const { revisarLlaves } = require('./cifrado');

const LARGO_MINIMO_SECRETO_SESION = 32;
// La carpeta de la aplicación (app/): lo que viva dentro está en el mismo servidor.
const RAIZ_APLICACION = path.resolve(__dirname, '..', '..');
const MARCADOR_DE_EJEMPLO = /change-me/i;

/**
 * Revisa que la configuración sensible esté completa y no sea la de ejemplo,
 * para que el servidor se niegue a arrancar antes de atender peticiones con
 * secretos débiles. Los mensajes nombran variables, nunca valores.
 *
 * @returns {string[]} problemas encontrados; vacío si se puede arrancar.
 *
 * Consumidores: src/server.js, src/tareas.js.
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

  const copia = problemaCopiaAuditoria(env);
  if (copia) problemas.push(copia);

  return [...problemas, ...revisarLlaves()];
}

/**
 * La copia externa de la auditoría solo delata a quien altere la original si
 * vive en otro equipo. En producción, sin AUDITORIA_COPIA_DIR (o con una ruta
 * dentro de la aplicación) caería en el mismo servidor, donde quien administra
 * la base también podría alterarla: no se acepta. Fuera de producción sirve la
 * carpeta de desarrollo.
 *
 * @param {object} [env] - por omisión, process.env.
 * @returns {(string|null)} el problema, o null si está bien.
 *
 * Consumidores: revisarEntorno(), auditoriaCopiaService.directorio().
 */
function problemaCopiaAuditoria(env = process.env) {
  if (env.NODE_ENV !== 'production') return null;
  const dir = env.AUDITORIA_COPIA_DIR;
  if (!dir) return 'AUDITORIA_COPIA_DIR no está definida: la copia de la auditoría debe ir a un almacenamiento de otro equipo';
  if (!path.isAbsolute(dir)) return 'AUDITORIA_COPIA_DIR debe ser una ruta absoluta';
  const relativa = path.relative(RAIZ_APLICACION, path.resolve(dir));
  if (relativa === '' || (!relativa.startsWith('..') && !path.isAbsolute(relativa))) {
    return 'AUDITORIA_COPIA_DIR está dentro de la aplicación: la copia debe ir a un almacenamiento de otro equipo';
  }
  return null;
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

module.exports = { revisarEntorno, revisarRolBase, problemaCopiaAuditoria };
