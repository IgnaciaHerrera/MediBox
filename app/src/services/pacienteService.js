const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');
const { AppError } = require('../lib/AppError');

const KEY = () => process.env.PACIENTE_ENCRYPTION_KEY;

async function crearPaciente(datos, usuarioId) {
  const { nombre, rut, fechaNacimiento, contacto, motivoConsulta } = datos;

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      INSERT INTO pacientes (nombre, rut_cifrado, fecha_nacimiento, contacto, motivo_consulta_cifrado, created_at)
      VALUES (
        ${nombre},
        pgp_sym_encrypt(${rut}, ${KEY()}),
        ${fechaNacimiento}::date,
        ${contacto},
        pgp_sym_encrypt(${motivoConsulta}, ${KEY()}),
        now()
      )
      RETURNING id, nombre, fecha_nacimiento AS "fechaNacimiento", contacto, created_at AS "createdAt"
    `;

    const paciente = rows[0];
    await registrar({ usuarioId, accion: 'CREATE', entidad: 'Paciente', entidadId: paciente.id }, tx);
    return paciente;
  });
}

async function obtenerPacientePorId(id, usuarioId) {
  const rows = await prisma.$queryRaw`
    SELECT
      id,
      nombre,
      pgp_sym_decrypt(rut_cifrado, ${KEY()}) AS rut,
      fecha_nacimiento AS "fechaNacimiento",
      contacto,
      pgp_sym_decrypt(motivo_consulta_cifrado, ${KEY()}) AS "motivoConsulta",
      created_at AS "createdAt"
    FROM pacientes WHERE id = ${id}
  `;

  const paciente = rows[0];
  if (!paciente) throw new AppError('Paciente no encontrado', 404);

  await registrar({ usuarioId, accion: 'READ', entidad: 'Paciente', entidadId: id });
  return paciente;
}

async function listarPacientes({ page = 1, pageSize = 20 } = {}, usuarioId) {
  const offset = (page - 1) * pageSize;
  const items = await prisma.$queryRaw`
    SELECT id, nombre, fecha_nacimiento AS "fechaNacimiento", contacto, created_at AS "createdAt"
    FROM pacientes
    ORDER BY created_at DESC
    OFFSET ${offset} LIMIT ${pageSize}
  `;
  const totalRows = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM pacientes`;

  await registrar({ usuarioId, accion: 'LIST', entidad: 'Paciente', entidadId: 0 });
  return { items, total: totalRows[0].count, page, pageSize };
}

module.exports = { crearPaciente, obtenerPacientePorId, listarPacientes };
