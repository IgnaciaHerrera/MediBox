-- Conservación de la auditoría, contención de cuentas y registro de
-- incidentes.

-- 1. La auditoría se conserva 15 años, igual que el registro del paciente
--    (Ley 20.584, art. 13), y después se elimina. El trigger sigue
--    rechazando todo UPDATE y TRUNCATE, y ahora acepta un DELETE solo de las
--    filas que ya cumplieron los 15 años: nadie, ni el dueño de la base,
--    puede borrar un rastro que todavía debe conservarse sin desactivar
--    antes el trigger, algo que solo puede hacer el dueño. La aplicación
--    (rol medibox_app) ni siquiera tiene DELETE: la purga la corre el dueño
--    con `npm run auditoria:purgar` (services/auditService.purgarVencidos).
CREATE OR REPLACE FUNCTION audit_log_solo_insercion() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."timestamp" < now() - interval '15 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log es de solo inserción: % no está permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- 2. Contención de una cuenta comprometida: suspenderla impide iniciar
--    sesión y corta en la petición siguiente las sesiones que tuviera
--    abiertas, sin borrar la cuenta (la auditoría la referencia).
ALTER TABLE "usuarios"
  ADD COLUMN "suspendida" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "suspendida_el" TIMESTAMP(3);

-- 3. Registro de incidentes (Ley 21.719, art. 14 sexies, inc. 2: el
--    responsable registra las vulneraciones, su naturaleza, sus efectos, las
--    categorías de datos, el número aproximado de titulares y las medidas).
--    No guarda datos de pacientes: solo conteos y categorías. El paso de un
--    estado a otro queda en la auditoría.
--      alerta -> sospechoso -> confirmado -> cerrado
--      alerta | sospechoso -> descartado
CREATE TABLE "incidentes" (
    "id" SERIAL NOT NULL,
    "titulo" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'alerta',
    "severidad" TEXT NOT NULL DEFAULT 'media',
    "dimension" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "detectado_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ocurrido_desde" TIMESTAMP(3),
    "ocurrido_hasta" TIMESTAMP(3),
    "categorias_datos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "titulares_afectados" INTEGER,
    "incluye_menores" BOOLEAN NOT NULL DEFAULT false,
    "consecuencias" TEXT,
    "medidas" TEXT,
    "recomendaciones" TEXT,
    "lecciones" TEXT,
    "sin_notificacion_motivo" TEXT,
    "notificado_agencia_el" TIMESTAMP(3),
    "notificado_titulares_el" TIMESTAMP(3),
    "notificado_csirt_el" TIMESTAMP(3),
    "cerrado_el" TIMESTAMP(3),
    "registrado_por" INTEGER NOT NULL,
    "actualizado_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "incidentes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "incidentes_estado_check" CHECK ("estado" IN ('alerta', 'sospechoso', 'confirmado', 'descartado', 'cerrado')),
    CONSTRAINT "incidentes_severidad_check" CHECK ("severidad" IN ('baja', 'media', 'alta', 'critica')),
    CONSTRAINT "incidentes_dimension_check" CHECK ("dimension" IN ('confidencialidad', 'integridad', 'disponibilidad')),
    CONSTRAINT "incidentes_origen_check" CHECK ("origen" IN ('alerta_automatica', 'reporte_funcionario', 'reporte_titular', 'hallazgo_externo')),
    CONSTRAINT "incidentes_titulares_check" CHECK ("titulares_afectados" IS NULL OR "titulares_afectados" >= 0),
    -- Cerrado solo con lecciones aprendidas y la decisión sobre la notificación tomada.
    CONSTRAINT "incidentes_cierre_check" CHECK (
      "estado" <> 'cerrado' OR (
        "cerrado_el" IS NOT NULL AND "lecciones" IS NOT NULL AND "medidas" IS NOT NULL
        AND ("notificado_agencia_el" IS NOT NULL OR "sin_notificacion_motivo" IS NOT NULL)
      )
    )
);
CREATE INDEX "incidentes_estado_idx" ON "incidentes"("estado");
ALTER TABLE "incidentes" ADD CONSTRAINT "incidentes_registrado_por_fkey" FOREIGN KEY ("registrado_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El gestor detecta (revisa alertas y auditoría) y privacidad coordina la
-- respuesta: ambos llevan el registro. Ninguno puede borrar un incidente.
INSERT INTO "permisos" ("clave") VALUES ('incidentes.gestionar') ON CONFLICT ("clave") DO NOTHING;
INSERT INTO "rol_permisos" ("rol_id", "permiso_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permisos" p ON p."clave" = 'incidentes.gestionar'
WHERE r."nombre" IN ('gestor', 'privacidad')
ON CONFLICT DO NOTHING;

-- La tabla nueva hereda SELECT, INSERT y UPDATE para medibox_app por los
-- privilegios por omisión (migración 20261023120000_rol_aplicacion); nunca DELETE.
