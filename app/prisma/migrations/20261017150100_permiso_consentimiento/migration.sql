-- Permiso para registrar consentimientos y revocaciones (Hito 3).
--
-- Lo tiene el operador, que atiende al paciente en admisión, por teléfono o
-- por correo. El médico no lo necesita para atender: no lo ve.

INSERT INTO "permisos" ("clave") VALUES ('consentimiento.write') ON CONFLICT ("clave") DO NOTHING;

INSERT INTO "rol_permisos" ("rol_id", "permiso_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permisos" p ON p."clave" = 'consentimiento.write'
WHERE r."nombre" = 'operador'
ON CONFLICT DO NOTHING;
