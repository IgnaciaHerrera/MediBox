-- Minimización de datos del paciente, paso 1 de 2 (expandir).
--
-- La fecha de nacimiento pasa a guardarse cifrada en la aplicación con la
-- llave de identidad (es un cuasi identificador). La columna en texto plano
-- se conserva hasta que `npm run minimizacion:migrar` la recifre; el paso 2
-- la elimina.
--
-- El contacto deja de ser obligatorio: solo sirve para avisar al paciente de
-- cambios en sus citas, y quien no lo entrega igual puede ser atendido.

ALTER TABLE "pacientes" ADD COLUMN "fecha_nacimiento_cifrada" BYTEA;

ALTER TABLE "pacientes" ALTER COLUMN "contacto_cifrado" DROP NOT NULL;
