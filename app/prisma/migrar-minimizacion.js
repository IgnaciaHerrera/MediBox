/* eslint-disable no-console -- script de línea de comandos */
// Prepara una base existente para 20261016120100_minimizacion_pacientes_contraer.
//
// Se ejecuta una vez, después de aplicar los pasos "expandir" (ver README):
//   1. Copia el motivo de consulta de legado de cada paciente a sus citas que
//      aún no tienen motivo (lo que antes hacía `npm run motivo:migrar`).
//   2. Cifra la fecha de nacimiento de cada paciente que aún no la tiene
//      cifrada.
// No basta con copiar en SQL: el nombre del campo es parte del cifrado (AAD),
// así que cada valor se descifra y se vuelve a cifrar en la aplicación.
//
// Usa SQL crudo porque el cliente de Prisma ya no conoce las columnas de
// legado (fecha_nacimiento y pacientes.motivo_consulta_cifrado). Es
// idempotente: solo toma filas pendientes y no borra nada; el paso
// "contraer" es el que elimina las columnas de legado.
const { PrismaClient } = require('@prisma/client');
const { cifrar, descifrar } = require('../src/lib/cifrado');

const prisma = new PrismaClient();

/**
 * Copia el motivo de legado del paciente a cada una de sus citas sin motivo.
 *
 * @returns {Promise<number>} pacientes que no se pudieron migrar.
 *
 * Consumidores: main().
 */
async function copiarMotivos() {
  const pendientes = await prisma.$queryRaw`
    SELECT c.id AS "citaId", p.id AS "pacienteId", p.motivo_consulta_cifrado AS "motivo"
    FROM citas c JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.motivo_consulta_cifrado IS NULL AND p.motivo_consulta_cifrado IS NOT NULL
  `;
  let errores = 0;
  for (const fila of pendientes) {
    try {
      const motivo = descifrar('paciente.motivoConsulta', fila.motivo);
      // Cada cita lleva su propio IV: se cifra una vez por cita.
      await prisma.$executeRaw`
        UPDATE citas SET motivo_consulta_cifrado = ${cifrar('cita.motivoConsulta', motivo)}
        WHERE id = ${fila.citaId}
      `;
    } catch (err) {
      errores += 1;
      // Solo los ids y el motivo del error, nunca los datos del paciente.
      console.error(`Cita ${fila.citaId} (paciente ${fila.pacienteId}): no se pudo copiar el motivo (${err.message})`);
    }
  }
  console.log(`Citas con el motivo del paciente copiado: ${pendientes.length - errores}.`);
  return errores;
}

/**
 * Cifra la fecha de nacimiento en claro de los pacientes que aún no la
 * tienen cifrada.
 *
 * @returns {Promise<number>} pacientes que no se pudieron migrar.
 *
 * Consumidores: main().
 */
async function cifrarFechas() {
  const pendientes = await prisma.$queryRaw`
    SELECT id, to_char(fecha_nacimiento, 'YYYY-MM-DD') AS "fecha"
    FROM pacientes WHERE fecha_nacimiento_cifrada IS NULL
  `;
  let errores = 0;
  for (const fila of pendientes) {
    try {
      await prisma.$executeRaw`
        UPDATE pacientes SET fecha_nacimiento_cifrada = ${cifrar('paciente.fechaNacimiento', fila.fecha)}
        WHERE id = ${fila.id}
      `;
    } catch (err) {
      errores += 1;
      console.error(`Paciente ${fila.id}: no se pudo cifrar su fecha de nacimiento (${err.message})`);
    }
  }
  console.log(`Fechas de nacimiento cifradas: ${pendientes.length - errores}.`);
  return errores;
}

async function main() {
  const errores = (await copiarMotivos()) + (await cifrarFechas());
  if (errores > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
