/* eslint-disable no-console -- script de línea de comandos */
// Copia el motivo de consulta de cada paciente a sus citas.
//
// Se ejecuta una vez después de la migración
// 20261003180000_motivo_en_citas_expandir (ver README). Por cada cita sin
// motivo, descifra el motivo de su paciente (columna de legado) y lo vuelve a
// cifrar como motivo de la cita. No basta con copiar el blob en SQL: el
// nombre del campo es parte del cifrado (AAD), así que hay que recifrarlo.
//
// Es idempotente: solo toma citas que aún no tienen motivo, y no toca el
// motivo del paciente. Los pacientes sin citas conservan su motivo de legado
// hasta el paso que elimine esa columna.
const { PrismaClient } = require('@prisma/client');
const { cifrar, descifrar } = require('../src/lib/cifrado');

const prisma = new PrismaClient();

async function main() {
  const pacientes = await prisma.paciente.findMany({
    where: { motivoConsultaCifrado: { not: null }, citas: { some: { motivoConsultaCifrado: null } } },
    select: { id: true, motivoConsultaCifrado: true },
  });

  let citasMigradas = 0;
  let pacientesConError = 0;
  for (const paciente of pacientes) {
    try {
      const motivo = descifrar('paciente.motivoConsulta', paciente.motivoConsultaCifrado);
      // Cada cita lleva su propio IV: se cifra una vez por cita.
      const citas = await prisma.cita.findMany({
        where: { pacienteId: paciente.id, motivoConsultaCifrado: null },
        select: { id: true },
      });
      await prisma.$transaction(
        citas.map((cita) =>
          prisma.cita.update({
            where: { id: cita.id },
            data: { motivoConsultaCifrado: cifrar('cita.motivoConsulta', motivo) },
          }),
        ),
      );
      citasMigradas += citas.length;
    } catch (err) {
      pacientesConError += 1;
      // Solo el id y el motivo del error, nunca los datos del paciente.
      console.error(`Paciente ${paciente.id}: no se pudo copiar su motivo (${err.message})`);
    }
  }

  const pendientes = await prisma.cita.count({
    where: { motivoConsultaCifrado: null, paciente: { motivoConsultaCifrado: { not: null } } },
  });
  console.log(`Citas con motivo copiado: ${citasMigradas}. Pendientes: ${pendientes}.`);
  if (pacientesConError > 0 || pendientes > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
