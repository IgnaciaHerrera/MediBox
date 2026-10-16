-- La auditoría es de solo inserción (Hito 3).
--
-- Quien actúa sobre los datos no debe poder alterar su propio rastro: ni la
-- aplicación (aunque la comprometan) ni un usuario con acceso a la base con
-- las credenciales de la aplicación pueden modificar, borrar o vaciar
-- audit_log. Solo se agregan filas.
--
-- Mejora operativa (fuera del código): que la aplicación se conecte con un
-- usuario de PostgreSQL sin permisos UPDATE, DELETE ni TRUNCATE sobre esta
-- tabla, distinto del dueño que aplica las migraciones. Con eso, ni siquiera
-- desactivar este trigger quedaría al alcance de la aplicación.

CREATE FUNCTION audit_log_solo_insercion() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción: % no está permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_sin_update_ni_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_solo_insercion();

CREATE TRIGGER audit_log_sin_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_solo_insercion();
