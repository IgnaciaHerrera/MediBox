-- Monitoreo y respuesta a incidentes (clase PR 06).
--
-- 1. Alertas con dueño y plazo. Hasta ahora las reglas se calculaban al
--    abrir /alertas y nadie quedaba a cargo. Cada alerta detectada se guarda
--    con su severidad, el rol responsable de revisarla y el plazo para
--    hacerlo; se cierra descartándola (con el motivo) o escalándola a un
--    incidente. No guarda datos de pacientes: la regla, la cuenta, cuántas
--    veces y cuándo. `sujeto` agrupa las detecciones repetidas de lo mismo
--    (u:<usuario>, e:<prefijo del HMAC del correo>, p:<paciente>, portal,
--    sistema).
CREATE TABLE "alertas" (
    "id" SERIAL NOT NULL,
    "regla" TEXT NOT NULL,
    "sujeto" TEXT NOT NULL,
    "usuario_id" INTEGER,
    "cantidad" INTEGER NOT NULL,
    "desde" TIMESTAMP(3) NOT NULL,
    "hasta" TIMESTAMP(3) NOT NULL,
    "severidad" TEXT NOT NULL,
    "responsable" TEXT NOT NULL,
    "detectada_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisar_antes_de" TIMESTAMP(3) NOT NULL,
    "vencida_avisada_el" TIMESTAMP(3),
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "revisada_por" INTEGER,
    "revisada_el" TIMESTAMP(3),
    "motivo" TEXT,
    "incidente_id" INTEGER,
    CONSTRAINT "alertas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alertas_estado_check" CHECK ("estado" IN ('pendiente', 'descartada', 'escalada')),
    CONSTRAINT "alertas_severidad_check" CHECK ("severidad" IN ('baja', 'media', 'alta', 'critica')),
    CONSTRAINT "alertas_periodo_check" CHECK ("hasta" >= "desde"),
    -- Revisada = descartada con su motivo, o escalada a un incidente.
    CONSTRAINT "alertas_revision_check" CHECK (
      ("estado" = 'pendiente' AND "revisada_el" IS NULL AND "revisada_por" IS NULL)
      OR ("estado" = 'descartada' AND "revisada_el" IS NOT NULL AND "revisada_por" IS NOT NULL AND "motivo" IS NOT NULL)
      OR ("estado" = 'escalada' AND "revisada_el" IS NOT NULL AND "revisada_por" IS NOT NULL AND "incidente_id" IS NOT NULL)
    )
);
CREATE INDEX "alertas_estado_plazo_idx" ON "alertas"("estado", "revisar_antes_de");
CREATE INDEX "alertas_regla_sujeto_idx" ON "alertas"("regla", "sujeto", "hasta");
ALTER TABLE "alertas" ADD CONSTRAINT "alertas_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alertas" ADD CONSTRAINT "alertas_revisada_por_fkey" FOREIGN KEY ("revisada_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alertas" ADD CONSTRAINT "alertas_incidente_id_fkey" FOREIGN KEY ("incidente_id") REFERENCES "incidentes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. La cuenta involucrada en un incidente (la comprometida, o la atacada):
--    con ella y el período se reconstruye lo ocurrido desde la auditoría.
ALTER TABLE "incidentes" ADD COLUMN "cuenta_involucrada_id" INTEGER;
ALTER TABLE "incidentes" ADD CONSTRAINT "incidentes_cuenta_involucrada_id_fkey" FOREIGN KEY ("cuenta_involucrada_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Bitácora del equipo de respuesta: cada acción, con su fase, la hora en
--    que se hizo y quién la anotó. Las acciones dentro de MediBox ya quedan
--    en la auditoría; aquí van también las de fuera (aislar un servidor,
--    llamar a la Agencia). Igual que la auditoría, es de solo inserción para
--    la aplicación: una anotación equivocada se corrige con otra.
CREATE TABLE "incidente_acciones" (
    "id" SERIAL NOT NULL,
    "incidente_id" INTEGER NOT NULL,
    "fase" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "realizada_el" TIMESTAMP(3) NOT NULL,
    "registrada_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrada_por" INTEGER NOT NULL,
    CONSTRAINT "incidente_acciones_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "incidente_acciones_fase_check" CHECK ("fase" IN ('deteccion', 'contencion', 'erradicacion', 'recuperacion', 'notificacion', 'lecciones'))
);
CREATE INDEX "incidente_acciones_incidente_idx" ON "incidente_acciones"("incidente_id", "realizada_el");
ALTER TABLE "incidente_acciones" ADD CONSTRAINT "incidente_acciones_incidente_id_fkey" FOREIGN KEY ("incidente_id") REFERENCES "incidentes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "incidente_acciones" ADD CONSTRAINT "incidente_acciones_registrada_por_fkey" FOREIGN KEY ("registrada_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
REVOKE UPDATE ON "incidente_acciones" FROM medibox_app;

-- 4. Revisar alertas: el gestor (detecta) y privacidad (las de exportaciones,
--    volumen y cambios de acceso, para que el administrador no revise los
--    cambios que él mismo hizo).
INSERT INTO "permisos" ("clave") VALUES ('alertas.revisar') ON CONFLICT ("clave") DO NOTHING;
INSERT INTO "rol_permisos" ("rol_id", "permiso_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permisos" p ON p."clave" = 'alertas.revisar'
WHERE r."nombre" IN ('gestor', 'privacidad')
ON CONFLICT DO NOTHING;
