-- Rol de privacidad y bloqueo de pacientes (Hito 3).
--
-- privacidad (encargado de protección de datos): revisa, ejecuta y responde
-- las solicitudes de derechos. Separación de funciones: el operador las
-- recibe y verifica, el admin custodia las llaves y no lee datos, el gestor
-- audita. Privacidad no lee pacientes en general: solo a través de una
-- solicitud.
--
-- Un paciente bloqueado (por un bloqueo o una supresión) se conserva, porque
-- la Ley 20.584, art. 13, obliga a conservar el registro clínico, pero no se
-- usa para nada: no aparece en listados, no se agenda y sale de los reportes.

-- dashboard.read y notificaciones.read existen en toda base sembrada; se
-- insertan igual para que la migración no dependa del orden del seed.
INSERT INTO "permisos" ("clave")
VALUES ('derechos.gestionar'), ('derechos.registrar'), ('dashboard.read'), ('notificaciones.read')
ON CONFLICT ("clave") DO NOTHING;

INSERT INTO "roles" ("nombre", "descripcion")
VALUES ('privacidad', 'Encargado de protección de datos: resuelve las solicitudes de derechos')
ON CONFLICT ("nombre") DO NOTHING;

INSERT INTO "rol_permisos" ("rol_id", "permiso_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permisos" p ON p."clave" IN ('dashboard.read', 'notificaciones.read', 'derechos.registrar', 'derechos.gestionar')
WHERE r."nombre" = 'privacidad'
ON CONFLICT DO NOTHING;

-- El motivo no se guarda en el paciente (la tabla no tiene ninguna columna
-- en texto plano): se deduce de la solicitud de supresión o bloqueo que lo
-- originó.
ALTER TABLE "pacientes"
  ADD COLUMN "bloqueado" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bloqueado_el" TIMESTAMP(3);
