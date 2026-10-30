-- Ciclo de vida de una solicitud de derechos (Ley 21.719, art. 11).
--
-- verificada_el: cuándo se verificó la identidad (antes solo se podía
--   deducir desde la verificación adjunta). Con recibida_el, vence_el y
--   resuelta_el quedan las fechas de cada paso: recepción, verificación,
--   evaluación y respuesta, y cierre.
-- resultado: cómo se cerró. 'parcial' es una denegación parcial: la ley
--   obliga a fundarla igual que un rechazo. La supresión siempre es parcial,
--   porque lo clínico se conserva bloqueado (Ley 20.584, art. 13).
-- prorrogada_el y prorroga_motivo_cifrado: el plazo de 30 días corridos se
--   puede prorrogar una sola vez, hasta por 30 días más. El motivo va cifrado
--   como la respuesta, porque puede referirse a los datos del titular.

ALTER TABLE "solicitudes_derechos"
  ADD COLUMN "verificada_el" TIMESTAMP(3),
  ADD COLUMN "resultado" TEXT,
  ADD COLUMN "prorrogada_el" TIMESTAMP(3),
  ADD COLUMN "prorroga_motivo_cifrado" BYTEA;

UPDATE "solicitudes_derechos" s
SET "verificada_el" = COALESCE(v."verificada_el", s."recibida_el")
FROM "verificaciones_identidad" v
WHERE v."id" = s."verificacion_id" AND s."identidad_verificada";

UPDATE "solicitudes_derechos"
SET "resultado" = CASE
  WHEN "estado" = 'rechazada' THEN 'rechazada'
  WHEN "derecho" = 'supresion' THEN 'parcial'
  ELSE 'atendida'
END
WHERE "estado" IN ('resuelta', 'rechazada');

ALTER TABLE "solicitudes_derechos"
  ADD CONSTRAINT "solicitudes_derechos_resultado_check" CHECK ("resultado" IS NULL OR "resultado" IN ('atendida', 'parcial', 'rechazada')),
  -- Una solicitud cerrada tiene resultado, y una abierta no.
  ADD CONSTRAINT "solicitudes_derechos_cerrada_con_resultado" CHECK (("estado" IN ('resuelta', 'rechazada')) = ("resultado" IS NOT NULL)),
  ADD CONSTRAINT "solicitudes_derechos_prorroga_con_motivo" CHECK (("prorrogada_el" IS NULL) = ("prorroga_motivo_cifrado" IS NULL));
