-- Minimización de datos del paciente, paso 2 de 2 (contraer).
--
-- Elimina dos columnas que ya no tienen finalidad propia:
--   - pacientes.fecha_nacimiento, la copia en texto plano de la fecha, que
--     ahora vive cifrada en fecha_nacimiento_cifrada.
--   - pacientes.motivo_consulta_cifrado, el motivo de legado: desde
--     20261003180000_motivo_en_citas_expandir cada cita tiene el suyo.
--
-- Se detiene sin cambiar nada si quedan datos sin migrar: eliminar las
-- columnas en ese estado los perdería. Un paciente con motivo de legado y
-- sin ninguna cita no lo detiene: ese motivo no orienta ninguna atención, y
-- conservarlo es justo lo que la minimización descarta.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pacientes" WHERE "fecha_nacimiento_cifrada" IS NULL) THEN
    RAISE EXCEPTION 'Hay pacientes con la fecha de nacimiento sin cifrar. Ejecuta "npm run minimizacion:migrar" y vuelve a aplicar las migraciones (ver README).';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "citas" c JOIN "pacientes" p ON p."id" = c."paciente_id"
    WHERE c."motivo_consulta_cifrado" IS NULL AND p."motivo_consulta_cifrado" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Hay citas sin el motivo de consulta de su paciente. Ejecuta "npm run minimizacion:migrar" y vuelve a aplicar las migraciones (ver README).';
  END IF;
END $$;

ALTER TABLE "pacientes"
  DROP COLUMN "fecha_nacimiento",
  DROP COLUMN "motivo_consulta_cifrado",
  ALTER COLUMN "fecha_nacimiento_cifrada" SET NOT NULL;
