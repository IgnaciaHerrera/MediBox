-- Historial de cambios del paciente (rectificación, Hito 3).
--
-- Toda edición de un paciente deja, por cada campo que cambió, el valor
-- anterior cifrado con la llave de su categoría (AAD 'historial.<campo>'),
-- quién lo cambió y cuándo. El valor nuevo ya vive en el paciente. Se
-- conserva igual que la ficha (Ley 20.584, art. 13): no se borra.

CREATE TABLE "historial_cambios" (
    "id" SERIAL NOT NULL,
    "paciente_id" INTEGER NOT NULL,
    "campo" TEXT NOT NULL,
    "valor_anterior_cifrado" BYTEA,
    "cambiado_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cambiado_por" INTEGER NOT NULL,
    -- La solicitud de rectificación que originó el cambio, si la hubo. La
    -- clave foránea se agrega con la tabla de solicitudes.
    "solicitud_id" INTEGER,

    CONSTRAINT "historial_cambios_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "historial_cambios_campo_check" CHECK ("campo" IN ('nombre', 'rut', 'fechaNacimiento', 'contacto'))
);

CREATE INDEX "historial_cambios_paciente_id_campo_idx" ON "historial_cambios"("paciente_id", "campo");

ALTER TABLE "historial_cambios" ADD CONSTRAINT "historial_cambios_paciente_id_fkey" FOREIGN KEY ("paciente_id") REFERENCES "pacientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "historial_cambios" ADD CONSTRAINT "historial_cambios_cambiado_por_fkey" FOREIGN KEY ("cambiado_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
