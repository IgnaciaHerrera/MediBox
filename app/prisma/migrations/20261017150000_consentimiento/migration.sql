-- Consentimiento por finalidad (Hito 3).
--
-- La atención, el registro, la agenda y los avisos de cambio o anulación de
-- una cita NO dependen del consentimiento: tienen base legal (órgano público
-- y dato de salud para la asistencia sanitaria, Hito 1). El consentimiento
-- cubre solo las finalidades secundarias, que el paciente puede rechazar o
-- revocar sin que cambie su atención.
--
-- Cada otorgamiento es una fila propia con la versión exacta del texto, el
-- canal, quién lo registró y la verificación de identidad que lo respalda.
-- Revocar llena revocado_el (con su canal, quién y su verificación): nunca se
-- borra ni se edita el otorgamiento. Un texto nuevo es una versión nueva y
-- los consentimientos anteriores quedan "a renovar".

CREATE TABLE "finalidades" (
    "id" SERIAL NOT NULL,
    "clave" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "finalidades_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finalidades_clave_key" ON "finalidades"("clave");

CREATE TABLE "textos_consentimiento" (
    "id" SERIAL NOT NULL,
    "finalidad_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "texto" TEXT NOT NULL,
    "vigente_desde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "textos_consentimiento_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "textos_consentimiento_finalidad_id_version_key" ON "textos_consentimiento"("finalidad_id", "version");
ALTER TABLE "textos_consentimiento" ADD CONSTRAINT "textos_consentimiento_finalidad_id_fkey" FOREIGN KEY ("finalidad_id") REFERENCES "finalidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "consentimientos" (
    "id" SERIAL NOT NULL,
    "paciente_id" INTEGER NOT NULL,
    "finalidad_id" INTEGER NOT NULL,
    "texto_id" INTEGER NOT NULL,
    "otorgado_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canal" TEXT NOT NULL,
    "otorgado_por" TEXT NOT NULL,
    -- {nombre, rut, relacion} del representante de un menor de 14, cifrado
    -- con la llave de identidad. Se elimina si se ejerce la supresión.
    "representante_cifrado" BYTEA,
    "registrado_por" INTEGER NOT NULL,
    "verificacion_id" INTEGER NOT NULL,
    "revocado_el" TIMESTAMP(3),
    "revocacion_canal" TEXT,
    "revocacion_registrada_por" INTEGER,
    "revocacion_verificacion_id" INTEGER,
    CONSTRAINT "consentimientos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consentimientos_canal_check" CHECK ("canal" IN ('presencial', 'telefono', 'correo')),
    CONSTRAINT "consentimientos_revocacion_canal_check" CHECK ("revocacion_canal" IS NULL OR "revocacion_canal" IN ('presencial', 'telefono', 'correo')),
    CONSTRAINT "consentimientos_otorgado_por_check" CHECK ("otorgado_por" IN ('titular', 'representante'))
);
CREATE INDEX "consentimientos_paciente_id_finalidad_id_idx" ON "consentimientos"("paciente_id", "finalidad_id");
ALTER TABLE "consentimientos" ADD CONSTRAINT "consentimientos_paciente_id_fkey" FOREIGN KEY ("paciente_id") REFERENCES "pacientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consentimientos" ADD CONSTRAINT "consentimientos_finalidad_id_fkey" FOREIGN KEY ("finalidad_id") REFERENCES "finalidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consentimientos" ADD CONSTRAINT "consentimientos_texto_id_fkey" FOREIGN KEY ("texto_id") REFERENCES "textos_consentimiento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consentimientos" ADD CONSTRAINT "consentimientos_registrado_por_fkey" FOREIGN KEY ("registrado_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consentimientos" ADD CONSTRAINT "consentimientos_revocacion_registrada_por_fkey" FOREIGN KEY ("revocacion_registrada_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consentimientos" ADD CONSTRAINT "consentimientos_verificacion_id_fkey" FOREIGN KEY ("verificacion_id") REFERENCES "verificaciones_identidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consentimientos" ADD CONSTRAINT "consentimientos_revocacion_verificacion_id_fkey" FOREIGN KEY ("revocacion_verificacion_id") REFERENCES "verificaciones_identidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Catálogo de las finalidades que requieren consentimiento, con su texto v1
-- (finalidad, destinatarios, plazo y cómo revocar). Va en la migración para
-- que exista también en las bases que ya estaban en uso.
INSERT INTO "finalidades" ("clave", "nombre", "descripcion") VALUES
  ('recordatorios', 'Recordatorios de citas', 'Recordatorio automático de cada cita, enviado al contacto registrado.'),
  ('investigacion', 'Investigación y estadística', 'Uso de datos seudonimizados en estudios o estadísticas distintos de la gestión habitual del hospital.'),
  ('encuestas', 'Encuestas de satisfacción', 'Contacto para responder encuestas sobre la atención recibida.');

INSERT INTO "textos_consentimiento" ("finalidad_id", "version", "texto")
SELECT f."id", 1, t."texto"
FROM "finalidades" f
JOIN (VALUES
  ('recordatorios', 'Autorizo al hospital a enviarme un recordatorio automático el día anterior a cada una de mis citas, al teléfono o correo que tengo registrado. Los avisos de cambio o anulación de una cita no dependen de esta autorización: se envían igual. Destinatarios: nadie fuera del hospital. Plazo: mientras no la revoque; mi contacto se elimina tras dos años sin citas. Puedo revocarla cuando quiera, en admisión, por teléfono o por correo, con el mismo procedimiento con que la otorgué. Negarme o revocarla no afecta mi atención. Más información en la política de tratamiento de datos (/privacidad).'),
  ('investigacion', 'Autorizo al hospital a usar mis datos seudonimizados (sin mi nombre, RUT ni contacto: solo un código, mi tramo de edad y el resumen de mis citas) en estudios de investigación o estadísticas distintos de la gestión habitual. Destinatarios: el equipo del hospital a cargo del estudio; nadie fuera del hospital. Plazo: mientras no la revoque; desde la revocación mis datos dejan de incluirse en los estudios nuevos. Puedo revocarla cuando quiera, en admisión, por teléfono o por correo, con el mismo procedimiento con que la otorgué. Negarme o revocarla no afecta mi atención. Más información en la política de tratamiento de datos (/privacidad).'),
  ('encuestas', 'Autorizo al hospital a contactarme, al teléfono o correo que tengo registrado, para responder encuestas de satisfacción sobre la atención recibida. Destinatarios: nadie fuera del hospital. Plazo: mientras no la revoque. Puedo revocarla cuando quiera, en admisión, por teléfono o por correo, con el mismo procedimiento con que la otorgué. Negarme o revocarla no afecta mi atención. Más información en la política de tratamiento de datos (/privacidad).')
) AS t("clave", "texto") ON t."clave" = f."clave";
