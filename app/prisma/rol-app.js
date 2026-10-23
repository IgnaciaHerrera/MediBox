const { PrismaClient } = require('@prisma/client');

const LARGO_MINIMO = 16;

/**
 * Activa el inicio de sesión del rol medibox_app (lo crea la migración
 * 20261023120000_rol_aplicacion sin login) con la contraseña de
 * APP_DB_PASSWORD. Se corre con las credenciales del dueño de la base,
 * después de aplicar las migraciones: la aplicación nunca recibe esas
 * credenciales. Es idempotente: volver a correrlo cambia la contraseña.
 *
 * @param {PrismaClient} prisma - cliente conectado como dueño de la base.
 * @param {string|undefined} clave - contraseña del rol (APP_DB_PASSWORD).
 * @returns {Promise<void>}
 * @throws {Error} si la contraseña falta o tiene menos de 16 caracteres.
 *
 * Consumidores: este archivo (servicio `migraciones` de docker-compose.yml)
 *   y tests/integration/rol-aplicacion.test.js.
 */
async function activarRolApp(prisma, clave) {
  if (!clave || clave.length < LARGO_MINIMO || /change-me/i.test(clave)) {
    throw new Error(`APP_DB_PASSWORD debe ser un valor aleatorio de al menos ${LARGO_MINIMO} caracteres`);
  }
  // ALTER ROLE no admite parámetros: format('%L') arma el literal escapado
  // dentro de la base, sin concatenar la contraseña en JavaScript.
  const [{ sentencia }] = await prisma.$queryRaw`
    SELECT format('ALTER ROLE medibox_app LOGIN PASSWORD %L', ${clave}::text) AS sentencia`;
  await prisma.$executeRawUnsafe(sentencia);
}

module.exports = { activarRolApp };

if (require.main === module) {
  const prisma = new PrismaClient();
  activarRolApp(prisma, process.env.APP_DB_PASSWORD)
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Rol medibox_app listo para iniciar sesión.');
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`No se pudo activar el rol medibox_app: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
