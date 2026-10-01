/* eslint-disable no-console -- script de línea de comandos */
// Migra los pacientes existentes al cifrado en la aplicación.
//
// Se ejecuta una sola vez, entre los dos pasos de la migración
// 20261001160000_cifrado_pacientes_expandir / ..._contraer (ver README).
// Lee el nombre y el contacto en texto plano, descifra el RUT y el motivo con
// la llave anterior de pgcrypto (PACIENTE_ENCRYPTION_KEY) y los vuelve a
// guardar cifrados con AES-256-GCM, vaciando las columnas de legado.
//
// Es idempotente: solo toma pacientes que aún no tienen nombre_cifrado, y
// cada uno se migra en su propia transacción. Si un paciente falla (por
// ejemplo, un RUT duplicado), se informa y se sigue con el resto; la
// migración de contracción no se aplicará hasta resolverlo.
const { PrismaClient } = require('@prisma/client');
const { cifrarPaciente } = require('../src/services/pacienteService');

const prisma = new PrismaClient();

async function migrarPaciente(id, llaveAnterior) {
  await prisma.$transaction(async (tx) => {
    // Última vez que una llave viaja a la base: después de esta migración
    // ninguna consulta vuelve a enviar llaves a PostgreSQL.
    const [fila] = await tx.$queryRaw`
      SELECT
        nombre_legado AS nombre,
        contacto_legado AS contacto,
        pgp_sym_decrypt(rut_pgp_legado, ${llaveAnterior}) AS rut,
        pgp_sym_decrypt(motivo_consulta_pgp_legado, ${llaveAnterior}) AS "motivoConsulta"
      FROM pacientes
      WHERE id = ${id}
      FOR UPDATE
    `;
    const cifrado = cifrarPaciente(fila);
    await tx.$executeRaw`
      UPDATE pacientes SET
        nombre_cifrado = ${cifrado.nombreCifrado},
        rut_cifrado = ${cifrado.rutCifrado},
        rut_indice = ${cifrado.rutIndice},
        contacto_cifrado = ${cifrado.contactoCifrado},
        motivo_consulta_cifrado = ${cifrado.motivoConsultaCifrado},
        nombre_legado = NULL,
        contacto_legado = NULL,
        rut_pgp_legado = NULL,
        motivo_consulta_pgp_legado = NULL
      WHERE id = ${id}
    `;
  });
}

async function main() {
  const llaveAnterior = process.env.PACIENTE_ENCRYPTION_KEY;
  if (!llaveAnterior) {
    throw new Error('Falta PACIENTE_ENCRYPTION_KEY: la llave de pgcrypto con la que se cifraron los datos existentes');
  }

  const pendientes = await prisma.$queryRaw`SELECT id FROM pacientes WHERE nombre_cifrado IS NULL ORDER BY id`;
  const fallidos = [];
  for (const { id } of pendientes) {
    try {
      await migrarPaciente(id, llaveAnterior);
    } catch (err) {
      fallidos.push(id);
      // Solo el motivo, nunca los valores de la fila. En SQL crudo Prisma
      // envuelve el error de PostgreSQL (23505 = violación de unicidad) en P2010.
      const meta = err.meta || {};
      const motivo = meta.code === '23505' ? 'RUT duplicado con otro paciente' : meta.message || err.message;
      console.error(`Paciente ${id}: no se pudo migrar (${motivo})`);
    }
  }

  console.log(`Pacientes migrados: ${pendientes.length - fallidos.length} de ${pendientes.length}`);
  if (fallidos.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
