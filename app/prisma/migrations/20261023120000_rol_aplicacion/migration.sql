-- La aplicación se conecta con un rol propio, de mínimo privilegio (Actividad 4).
--
-- Hasta ahora la aplicación usaba el mismo usuario que aplica las migraciones:
-- el dueño de todas las tablas y, en Docker, superusuario. Con esas
-- credenciales cualquiera que tomara el control de la aplicación podía
-- desactivar el trigger de solo inserción de audit_log, borrar pacientes o
-- cambiar el esquema. medibox_app solo puede lo que la aplicación hace:
--
--   - leer, insertar y actualizar las tablas del sistema;
--   - borrar solo donde la aplicación borra (sesiones, notificaciones vencidas,
--     permisos de un rol y el catálogo de espacios y médicos). Pacientes,
--     citas, consentimientos, solicitudes, historial y verificaciones no se
--     borran nunca: se anulan, se bloquean o se vacía un campo;
--   - en audit_log, solo leer e insertar;
--   - nada de DDL (no es dueño de nada: no puede desactivar triggers ni
--     alterar tablas) ni acceso a _prisma_migrations.
--
-- El rol se crea sin login: la contraseña no puede estar en el repositorio.
-- La activa prisma/rol-app.js con APP_DB_PASSWORD (lo corre el servicio
-- `migraciones` de docker-compose.yml).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medibox_app') THEN
    CREATE ROLE medibox_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- La tabla de sesiones la creaba connect-pg-simple en el primer arranque, lo
-- que exigía que la aplicación pudiera crear tablas. Ahora la crea la
-- migración, con la definición de connect-pg-simple (table.sql).
CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL,
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO medibox_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO medibox_app;
REVOKE CREATE ON SCHEMA public FROM medibox_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO medibox_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO medibox_app;

REVOKE ALL ON "_prisma_migrations" FROM medibox_app;
REVOKE UPDATE ON "audit_log" FROM medibox_app;

GRANT DELETE ON "session", "notificaciones", "rol_permisos", "pasillos", "boxes", "instrumentos", "especialidades", "medicos" TO medibox_app;

-- Las tablas que agreguen las migraciones siguientes nacen con lectura,
-- inserción y actualización, y sin DELETE: borrar en una tabla nueva exige
-- concederlo a propósito en su migración.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO medibox_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO medibox_app;
