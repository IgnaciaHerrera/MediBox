-- Cifrado de pacientes en la aplicación, paso 2 de 2 (contraer).
--
-- Se detiene sin cambiar nada si queda algún paciente sin migrar: eliminar
-- las columnas de legado en ese estado borraría sus datos.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pacientes"
    WHERE "nombre_cifrado" IS NULL OR "rut_cifrado" IS NULL OR "rut_indice" IS NULL
       OR "contacto_cifrado" IS NULL OR "motivo_consulta_cifrado" IS NULL
  ) THEN
    RAISE EXCEPTION 'Hay pacientes sin migrar al cifrado en la aplicación. Ejecuta "npm run cifrado:migrar" y vuelve a aplicar las migraciones (ver README).';
  END IF;
END $$;

ALTER TABLE "pacientes"
  DROP COLUMN "nombre_legado",
  DROP COLUMN "contacto_legado",
  DROP COLUMN "rut_pgp_legado",
  DROP COLUMN "motivo_consulta_pgp_legado",
  ALTER COLUMN "nombre_cifrado" SET NOT NULL,
  ALTER COLUMN "rut_cifrado" SET NOT NULL,
  ALTER COLUMN "rut_indice" SET NOT NULL,
  ALTER COLUMN "contacto_cifrado" SET NOT NULL,
  ALTER COLUMN "motivo_consulta_cifrado" SET NOT NULL;
