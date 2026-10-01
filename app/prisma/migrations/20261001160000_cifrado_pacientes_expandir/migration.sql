-- Cifrado de pacientes en la aplicación, paso 1 de 2 (expandir).
--
-- Las columnas actuales quedan como "legado" y pasan a ser opcionales: el
-- nombre y el contacto estaban en texto plano, y el RUT y el motivo cifrados
-- con pgcrypto. Se agregan las columnas que llena la aplicación con
-- AES-256-GCM y el índice ciego del RUT.
--
-- Una base que ya tiene pacientes debe ejecutar `npm run cifrado:migrar`
-- antes del paso 2, que elimina las columnas de legado (ver README).

ALTER TABLE "pacientes" RENAME COLUMN "nombre" TO "nombre_legado";
ALTER TABLE "pacientes" RENAME COLUMN "contacto" TO "contacto_legado";
ALTER TABLE "pacientes" RENAME COLUMN "rut_cifrado" TO "rut_pgp_legado";
ALTER TABLE "pacientes" RENAME COLUMN "motivo_consulta_cifrado" TO "motivo_consulta_pgp_legado";

ALTER TABLE "pacientes"
  ALTER COLUMN "nombre_legado" DROP NOT NULL,
  ALTER COLUMN "contacto_legado" DROP NOT NULL,
  ALTER COLUMN "rut_pgp_legado" DROP NOT NULL,
  ALTER COLUMN "motivo_consulta_pgp_legado" DROP NOT NULL,
  ADD COLUMN "nombre_cifrado" BYTEA,
  ADD COLUMN "rut_cifrado" BYTEA,
  ADD COLUMN "rut_indice" BYTEA,
  ADD COLUMN "contacto_cifrado" BYTEA,
  ADD COLUMN "motivo_consulta_cifrado" BYTEA;

CREATE UNIQUE INDEX "pacientes_rut_indice_key" ON "pacientes"("rut_indice");
