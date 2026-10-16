-- Auditoría ampliada (Hito 3).
--
-- Registra quién (un usuario o el sistema), qué, sobre qué registro, cuándo,
-- desde dónde y con qué resultado, sin guardar el dato personal mismo:
--   - usuario_id pasa a ser opcional: lo que ejecuta el sistema (retención,
--     recordatorios, alertas) y los inicios de sesión con un correo que no
--     existe no tienen usuario.
--   - email_indice: HMAC del correo de un inicio de sesión fallido. Permite
--     contar intentos sobre una misma cuenta sin guardar el correo en claro.
--   - detalle: conteos o referencias internas, nunca datos personales.
-- Solo agrega columnas con valores por omisión: no toca las filas existentes.

ALTER TABLE "audit_log"
  ALTER COLUMN "usuario_id" DROP NOT NULL,
  ADD COLUMN "actor" TEXT NOT NULL DEFAULT 'usuario',
  ADD COLUMN "resultado" TEXT NOT NULL DEFAULT 'exito',
  ADD COLUMN "ip" TEXT,
  ADD COLUMN "email_indice" BYTEA,
  ADD COLUMN "detalle" JSONB,
  ADD CONSTRAINT "audit_log_actor_check" CHECK ("actor" IN ('usuario', 'sistema')),
  ADD CONSTRAINT "audit_log_resultado_check" CHECK ("resultado" IN ('exito', 'denegado', 'fallido'));

-- Las reglas de monitoreo filtran por acción dentro de una ventana de tiempo.
CREATE INDEX "audit_log_accion_timestamp_idx" ON "audit_log"("accion", "timestamp");
