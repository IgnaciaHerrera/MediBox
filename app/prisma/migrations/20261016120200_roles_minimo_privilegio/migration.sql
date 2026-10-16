-- Roles con mínimo privilegio y separación de funciones (Hito 2).
--
-- Ajusta los roles predeterminados de una base existente al modelo de
-- prisma/seed.js. En una base nueva los roles aún no existen al migrar: solo
-- se crean los permisos nuevos y el seed arma los roles ya con este modelo.
--
-- - medico: deja de leer a cualquier paciente; solo a los que tienen o
--   tuvieron una cita con él (Ley 20.584, art. 13), y puede registrar el
--   estado de sus propias citas.
-- - gestor: gestiona espacios, datos y auditoría; no necesita la identidad
--   de los pacientes ni agendar citas.
-- - admin: administra cuentas, roles y configuración. Custodia las llaves,
--   así que no puede además leer los datos que protegen ni auditar los
--   accesos: queda solo con lo que su función requiere.

INSERT INTO "permisos" ("clave")
VALUES ('paciente.read.propios'), ('agenda.estado.propias')
ON CONFLICT ("clave") DO NOTHING;

DELETE FROM "rol_permisos" rp
USING "roles" r, "permisos" p
WHERE rp."rol_id" = r."id" AND rp."permiso_id" = p."id" AND (
  (r."nombre" = 'medico' AND p."clave" = 'paciente.read')
  OR (r."nombre" = 'gestor' AND p."clave" IN ('paciente.read', 'agenda.write'))
  OR (r."nombre" = 'admin' AND p."clave" NOT IN (
    'dashboard.read', 'medicos.read', 'notificaciones.read', 'admin.users', 'admin.roles', 'admin.system'
  ))
);

INSERT INTO "rol_permisos" ("rol_id", "permiso_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permisos" p ON p."clave" IN ('paciente.read.propios', 'agenda.estado.propias')
WHERE r."nombre" = 'medico'
ON CONFLICT DO NOTHING;
