-- Portal temporal del titular (clase PR 004: "Descargar mis datos", corregir,
-- oponerse y revocar sin depender de un funcionario).
--
-- El titular ingresa con su RUT y un código de un solo uso enviado al contacto
-- que ya tenía registrado; no hay cuentas de pacientes. Lo que hace en el
-- portal no lo registra un funcionario, así que quién verificó, registró o
-- recibió queda vacío. Cada CHECK nuevo garantiza que eso solo ocurra en el
-- portal: toda acción del personal sigue exigiendo a su funcionario. (La
-- revocación ya admitía no tener funcionario: la hace también el sistema al
-- reaplicar una supresión.)

-- Verificaciones: método nuevo 'codigo_portal', sin funcionario.
ALTER TABLE "verificaciones_identidad" ALTER COLUMN "verificada_por" DROP NOT NULL;
ALTER TABLE "verificaciones_identidad" DROP CONSTRAINT "verificaciones_identidad_metodo_check";
ALTER TABLE "verificaciones_identidad"
  ADD CONSTRAINT "verificaciones_identidad_metodo_check" CHECK ("metodo" IN ('cedula_presencial', 'codigo_contacto', 'codigo_portal'));
ALTER TABLE "verificaciones_identidad" DROP CONSTRAINT "verificaciones_identidad_codigo_check";
-- Un código (al funcionario o en el portal) siempre lleva su hash, su sal y
-- su vencimiento, salvo que la retención ya haya borrado el hash y la sal de
-- uno usado o vencido.
ALTER TABLE "verificaciones_identidad"
  ADD CONSTRAINT "verificaciones_identidad_codigo_check" CHECK (
    "metodo" = 'cedula_presencial' OR ("expira_el" IS NOT NULL AND ("codigo_hash" IS NULL) = ("sal" IS NULL))
  );
ALTER TABLE "verificaciones_identidad"
  ADD CONSTRAINT "verificaciones_sin_funcionario_solo_portal" CHECK (("verificada_por" IS NULL) = ("metodo" = 'codigo_portal'));

-- Consentimientos: canal 'portal', sin funcionario.
ALTER TABLE "consentimientos" ALTER COLUMN "registrado_por" DROP NOT NULL;
ALTER TABLE "consentimientos" DROP CONSTRAINT "consentimientos_canal_check";
ALTER TABLE "consentimientos"
  ADD CONSTRAINT "consentimientos_canal_check" CHECK ("canal" IN ('presencial', 'telefono', 'correo', 'portal'));
ALTER TABLE "consentimientos" DROP CONSTRAINT "consentimientos_revocacion_canal_check";
ALTER TABLE "consentimientos"
  ADD CONSTRAINT "consentimientos_revocacion_canal_check" CHECK ("revocacion_canal" IS NULL OR "revocacion_canal" IN ('presencial', 'telefono', 'correo', 'portal'));
ALTER TABLE "consentimientos"
  ADD CONSTRAINT "consentimientos_sin_funcionario_solo_portal" CHECK (("registrado_por" IS NULL) = ("canal" = 'portal'));

-- Solicitudes: canal, método y entrega 'portal', sin funcionario.
ALTER TABLE "solicitudes_derechos" ALTER COLUMN "recibida_por" DROP NOT NULL;
ALTER TABLE "solicitudes_derechos" DROP CONSTRAINT "solicitudes_derechos_canal_check";
ALTER TABLE "solicitudes_derechos"
  ADD CONSTRAINT "solicitudes_derechos_canal_check" CHECK ("canal" IN ('presencial', 'telefono', 'correo', 'portal'));
ALTER TABLE "solicitudes_derechos" DROP CONSTRAINT "solicitudes_derechos_metodo_check";
ALTER TABLE "solicitudes_derechos"
  ADD CONSTRAINT "solicitudes_derechos_metodo_check" CHECK ("metodo_verificacion" IS NULL OR "metodo_verificacion" IN ('cedula_presencial', 'codigo_contacto', 'codigo_portal'));
ALTER TABLE "solicitudes_derechos" DROP CONSTRAINT "solicitudes_derechos_entrega_check";
ALTER TABLE "solicitudes_derechos"
  ADD CONSTRAINT "solicitudes_derechos_entrega_check" CHECK ("entrega" IS NULL OR "entrega" IN ('contacto_registrado', 'presencial', 'portal'));
ALTER TABLE "solicitudes_derechos" DROP CONSTRAINT "solicitudes_derechos_verificada_check";
-- Verificada significa con método y verificación, y con quién verificó salvo
-- que la verificación sea el código del propio titular en el portal.
ALTER TABLE "solicitudes_derechos"
  ADD CONSTRAINT "solicitudes_derechos_verificada_check" CHECK (
    NOT "identidad_verificada"
    OR ("metodo_verificacion" IS NOT NULL AND "verificacion_id" IS NOT NULL AND ("verificada_por" IS NOT NULL OR "metodo_verificacion" = 'codigo_portal'))
  );
ALTER TABLE "solicitudes_derechos"
  ADD CONSTRAINT "solicitudes_sin_funcionario_solo_portal" CHECK (("recibida_por" IS NULL) = ("canal" = 'portal'));

-- Auditoría: el titular en el portal ('titular', ya verificado) y quien pide
-- o prueba un código antes de verificarse ('portal').
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_check";
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_check" CHECK ("actor" IN ('usuario', 'sistema', 'titular', 'portal'));
