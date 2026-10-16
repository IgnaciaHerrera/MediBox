-- Verificación de identidad del titular (Hito 3).
--
-- Antes de ejecutar un derecho o de cambiar un consentimiento, un
-- funcionario verifica que quien pide es el titular, con uno de dos métodos:
--   - cedula_presencial: vio la cédula en admisión. Es la base y sirve para
--     todos los pacientes.
--   - codigo_contacto: un código de un solo uso enviado al contacto que el
--     paciente ya tenía registrado, que el titular le dicta. Del código solo
--     se guarda su hash (con sal), su vencimiento y los intentos.
-- Cada fila deja el método y quién verificó: es la prueba de la verificación.

CREATE TABLE "verificaciones_identidad" (
    "id" SERIAL NOT NULL,
    "paciente_id" INTEGER NOT NULL,
    "metodo" TEXT NOT NULL,
    "verificada_por" INTEGER NOT NULL,
    "creada_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificada_el" TIMESTAMP(3),
    "codigo_hash" BYTEA,
    "sal" BYTEA,
    "expira_el" TIMESTAMP(3),
    "intentos" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "verificaciones_identidad_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "verificaciones_identidad_metodo_check" CHECK ("metodo" IN ('cedula_presencial', 'codigo_contacto')),
    -- Un código siempre lleva su hash, su sal y su vencimiento.
    CONSTRAINT "verificaciones_identidad_codigo_check" CHECK (
      "metodo" <> 'codigo_contacto' OR ("codigo_hash" IS NOT NULL AND "sal" IS NOT NULL AND "expira_el" IS NOT NULL)
    )
);

CREATE INDEX "verificaciones_identidad_paciente_id_verificada_por_idx" ON "verificaciones_identidad"("paciente_id", "verificada_por");

ALTER TABLE "verificaciones_identidad" ADD CONSTRAINT "verificaciones_identidad_paciente_id_fkey" FOREIGN KEY ("paciente_id") REFERENCES "pacientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verificaciones_identidad" ADD CONSTRAINT "verificaciones_identidad_verificada_por_fkey" FOREIGN KEY ("verificada_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
