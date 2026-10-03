-- Motivo de consulta por cita, paso 1 de 2 (expandir).
--
-- Cada cita pasa a tener su propio motivo, cifrado en la aplicación con la
-- misma llave clínica. El motivo del paciente queda como legado y opcional:
-- `npm run motivo:migrar` lo copia a las citas existentes (ver README). Un
-- paso posterior eliminará la columna del paciente.

ALTER TABLE "citas" ADD COLUMN "motivo_consulta_cifrado" BYTEA;

ALTER TABLE "pacientes" ALTER COLUMN "motivo_consulta_cifrado" DROP NOT NULL;
