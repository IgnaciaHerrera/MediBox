-- Solicitudes de derechos del titular (ARCO+, Hito 3).
--
-- Llegan por cualquier canal (en admisión, por teléfono o por correo) y las
-- registra un funcionario, sin costo para el titular y sin exigir todavía la
-- verificación de identidad: una solicitud que no se puede verificar queda
-- pendiente ('recibida') hasta la próxima visita, nunca se rechaza por eso.
-- Para actuar, la solicitud guarda la verificación con el método que acepta
-- cada derecho (supresión y bloqueo, solo con cédula) y quién verificó.
--
-- Lo que pide una rectificación (valor_propuesto_cifrado) y lo que se le
-- respondió al titular (respuesta_cifrada) se guardan cifrados.

CREATE TABLE "solicitudes_derechos" (
    "id" SERIAL NOT NULL,
    "paciente_id" INTEGER NOT NULL,
    "derecho" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'recibida',
    "canal" TEXT NOT NULL,
    "recibida_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vence_el" TIMESTAMP(3) NOT NULL,
    "recibida_por" INTEGER NOT NULL,
    "solicitante_es_representante" BOOLEAN NOT NULL DEFAULT false,
    "solicitante_relacion" TEXT,
    "campo" TEXT,
    "valor_propuesto_cifrado" BYTEA,
    "finalidad_clave" TEXT,
    "identidad_verificada" BOOLEAN NOT NULL DEFAULT false,
    "metodo_verificacion" TEXT,
    "verificacion_id" INTEGER,
    "verificada_por" INTEGER,
    "entrega" TEXT,
    "respuesta_cifrada" BYTEA,
    "resuelta_el" TIMESTAMP(3),
    "resuelta_por" INTEGER,

    CONSTRAINT "solicitudes_derechos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "solicitudes_derechos_derecho_check" CHECK ("derecho" IN ('acceso', 'portabilidad', 'rectificacion', 'supresion', 'bloqueo', 'oposicion')),
    CONSTRAINT "solicitudes_derechos_estado_check" CHECK ("estado" IN ('recibida', 'verificada', 'resuelta', 'rechazada')),
    CONSTRAINT "solicitudes_derechos_canal_check" CHECK ("canal" IN ('presencial', 'telefono', 'correo')),
    CONSTRAINT "solicitudes_derechos_campo_check" CHECK ("campo" IS NULL OR "campo" IN ('nombre', 'rut', 'fechaNacimiento', 'contacto')),
    CONSTRAINT "solicitudes_derechos_metodo_check" CHECK ("metodo_verificacion" IS NULL OR "metodo_verificacion" IN ('cedula_presencial', 'codigo_contacto')),
    CONSTRAINT "solicitudes_derechos_entrega_check" CHECK ("entrega" IS NULL OR "entrega" IN ('contacto_registrado', 'presencial')),
    -- Verificada significa con método, verificación y quién verificó.
    CONSTRAINT "solicitudes_derechos_verificada_check" CHECK (
      NOT "identidad_verificada" OR ("metodo_verificacion" IS NOT NULL AND "verificacion_id" IS NOT NULL AND "verificada_por" IS NOT NULL)
    )
);

CREATE INDEX "solicitudes_derechos_paciente_id_idx" ON "solicitudes_derechos"("paciente_id");
CREATE INDEX "solicitudes_derechos_estado_vence_el_idx" ON "solicitudes_derechos"("estado", "vence_el");

ALTER TABLE "solicitudes_derechos" ADD CONSTRAINT "solicitudes_derechos_paciente_id_fkey" FOREIGN KEY ("paciente_id") REFERENCES "pacientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "solicitudes_derechos" ADD CONSTRAINT "solicitudes_derechos_recibida_por_fkey" FOREIGN KEY ("recibida_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "solicitudes_derechos" ADD CONSTRAINT "solicitudes_derechos_verificada_por_fkey" FOREIGN KEY ("verificada_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "solicitudes_derechos" ADD CONSTRAINT "solicitudes_derechos_resuelta_por_fkey" FOREIGN KEY ("resuelta_por") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "solicitudes_derechos" ADD CONSTRAINT "solicitudes_derechos_verificacion_id_fkey" FOREIGN KEY ("verificacion_id") REFERENCES "verificaciones_identidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- La rectificación que originó un cambio del paciente.
ALTER TABLE "historial_cambios" ADD CONSTRAINT "historial_cambios_solicitud_id_fkey" FOREIGN KEY ("solicitud_id") REFERENCES "solicitudes_derechos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El operador recibe las solicitudes (en admisión, por teléfono o por correo)
-- y verifica la identidad; quien las resuelve es el rol de privacidad.
INSERT INTO "permisos" ("clave") VALUES ('derechos.registrar') ON CONFLICT ("clave") DO NOTHING;

INSERT INTO "rol_permisos" ("rol_id", "permiso_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permisos" p ON p."clave" = 'derechos.registrar'
WHERE r."nombre" = 'operador'
ON CONFLICT DO NOTHING;
