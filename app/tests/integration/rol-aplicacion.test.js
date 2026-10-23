const crypto = require('crypto');
const { URL } = require('url');
const { PrismaClient } = require('@prisma/client');
const { activarRolApp } = require('../../prisma/rol-app');
const { revisarRolBase } = require('../../src/lib/entorno');

// Los roles de PostgreSQL son del clúster, no de la base: cambiar la
// contraseña de medibox_app aquí rompería la app de desarrollo que comparte
// el contenedor. Se prueba con un rol temporal miembro de medibox_app, que
// hereda exactamente los permisos que le dio la migración.
const dueno = new PrismaClient();
const rolTemporal = `medibox_app_prueba_${process.pid}`;
const clave = crypto.randomBytes(24).toString('hex');
let app;

/**
 * Ejecuta una sentencia como el rol de la aplicación y devuelve el código de
 * error de PostgreSQL con que la base la rechaza (o null si la acepta).
 */
async function codigoAlEjecutar(sql) {
  try {
    await app.$executeRawUnsafe(sql);
    return null;
  } catch (err) {
    return err.meta?.code ?? err.code;
  }
}

beforeAll(async () => {
  await dueno.$executeRawUnsafe(`CREATE ROLE ${rolTemporal} LOGIN INHERIT PASSWORD '${clave}' IN ROLE medibox_app`);
  const url = new URL(process.env.DATABASE_URL);
  url.username = rolTemporal;
  url.password = clave;
  app = new PrismaClient({ datasources: { db: { url: url.toString() } } });
});

afterAll(async () => {
  await app.$disconnect();
  await dueno.$executeRawUnsafe(`DROP ROLE IF EXISTS ${rolTemporal}`);
  await dueno.$disconnect();
});

describe('rol de la aplicación en la base (medibox_app)', () => {
  it('no es superusuario ni puede saltarse la seguridad por filas', async () => {
    const [rol] = await dueno.$queryRaw`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'medibox_app'`;
    expect(rol).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('lee las tablas y escribe en la auditoría, como hace la aplicación', async () => {
    await expect(app.paciente.count()).resolves.toEqual(expect.any(Number));
    await expect(app.cita.count()).resolves.toEqual(expect.any(Number));
    const fila = await app.auditLog.create({
      data: { actor: 'sistema', accion: 'PRUEBA_ROL', entidad: 'Sistema', entidadId: 0 },
    });
    expect(fila.id).toEqual(expect.any(Number));
  });

  it('borra solo donde la aplicación borra', async () => {
    expect(await codigoAlEjecutar('DELETE FROM "notificaciones" WHERE id = -1')).toBeNull();
    expect(await codigoAlEjecutar('DELETE FROM "session" WHERE sid = \'no-existe\'')).toBeNull();
  });

  it.each(['pacientes', 'citas', 'consentimientos', 'solicitudes_derechos', 'historial_cambios', 'verificaciones_identidad', 'usuarios'])(
    'la base rechaza borrar en %s',
    async (tabla) => {
      expect(await codigoAlEjecutar(`DELETE FROM "${tabla}" WHERE id = -1`)).toBe('42501');
    },
  );

  it('la base rechaza modificar, borrar o vaciar la auditoría, antes de llegar al trigger', async () => {
    expect(await codigoAlEjecutar('UPDATE "audit_log" SET accion = \'X\' WHERE id = -1')).toBe('42501');
    expect(await codigoAlEjecutar('DELETE FROM "audit_log" WHERE id = -1')).toBe('42501');
    expect(await codigoAlEjecutar('TRUNCATE "audit_log"')).toBe('42501');
  });

  it('no puede desactivar el trigger de la auditoría ni cambiar el esquema', async () => {
    expect(await codigoAlEjecutar('ALTER TABLE "audit_log" DISABLE TRIGGER ALL')).toBe('42501');
    expect(await codigoAlEjecutar('DROP TABLE "citas"')).toBe('42501');
    expect(await codigoAlEjecutar('CREATE TABLE "copia_pacientes" (id int)')).toBe('42501');
  });

  it('no ve el historial de migraciones', async () => {
    expect(await codigoAlEjecutar('SELECT * FROM "_prisma_migrations"')).toBe('42501');
  });
});

describe('revisarRolBase', () => {
  it('rechaza arrancar con el dueño de la base', async () => {
    expect(await revisarRolBase(dueno)).toHaveLength(1);
  });

  it('acepta el rol de la aplicación', async () => {
    expect(await revisarRolBase(app)).toEqual([]);
  });
});

describe('activarRolApp', () => {
  it.each([undefined, '', 'corta', 'change-me-change-me-change-me'])('rechaza la contraseña %p sin tocar la base', async (valor) => {
    await expect(activarRolApp(null, valor)).rejects.toThrow('APP_DB_PASSWORD');
  });
});
