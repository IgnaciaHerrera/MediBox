-- Consentimiento de adolescentes y acreditación de la representación.
--
-- 1. Ley 21.719, art. 16 quáter, inc. 4: los datos sensibles de un
--    adolescente menor de 16 años solo se tratan con el consentimiento de sus
--    padres, representantes legales o quien tiene su cuidado personal. La
--    regla de los 14 años vale solo para las finalidades que no tocan datos
--    sensibles. Las tres finalidades actuales los tocan:
--      - recordatorios: el aviso revela que la persona se atiende en el
--        hospital (dato de salud);
--      - investigacion: usa el resumen de sus citas (dato de salud);
--      - encuestas: el contacto es sobre la atención recibida.
--    Una finalidad futura sin datos sensibles (p. ej. un boletín) quedaría
--    en false y seguiría la regla de los 14.
--
-- 2. Quien actúa como representante debe acreditar la representación, no
--    solo declararla (clase PR 05: verificación doble, de la identidad del
--    representante y de la representación). Se guarda solo el tipo de
--    documento que el funcionario vio, nunca una copia:
--    certificado_nacimiento | resolucion_judicial | poder_notarial, o
--    'declarada' cuando llega por el portal o por teléfono sin documento.
--    En el consentimiento va dentro de representante_cifrado (JSON).

ALTER TABLE "finalidades" ADD COLUMN "datos_sensibles" BOOLEAN NOT NULL DEFAULT false;
UPDATE "finalidades" SET "datos_sensibles" = true WHERE "clave" IN ('recordatorios', 'investigacion', 'encuestas');

ALTER TABLE "solicitudes_derechos" ADD COLUMN "solicitante_acreditacion" TEXT;
ALTER TABLE "solicitudes_derechos" ADD CONSTRAINT "solicitudes_derechos_solicitante_acreditacion_check"
  CHECK ("solicitante_acreditacion" IS NULL OR "solicitante_acreditacion" IN ('certificado_nacimiento', 'resolucion_judicial', 'poder_notarial', 'declarada'));
-- Las solicitudes de un representante ya registradas no tenían documento.
UPDATE "solicitudes_derechos" SET "solicitante_acreditacion" = 'declarada' WHERE "solicitante_es_representante";
