const { prisma } = require('../lib/prisma');
const { registrar } = require('./auditService');
const { AppError } = require('../lib/AppError');

const CABECERA_ESPERADA = 'pasillo,box';

function parsearCsvEspacios(texto) {
  const lineas = texto
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0);

  if (lineas.length === 0) {
    throw new AppError('El archivo CSV está vacío', 400);
  }

  if (lineas[0].toLowerCase().replace(/\s+/g, '') === CABECERA_ESPERADA) {
    lineas.shift();
  }

  return lineas.map((linea, indice) => {
    const columnas = linea.split(',').map((c) => c.trim());
    if (columnas.length !== 2 || !columnas[0] || !columnas[1]) {
      throw new AppError(`Línea ${indice + 1} inválida: se esperaba "pasillo,box"`, 400);
    }
    return { pasillo: columnas[0], box: columnas[1] };
  });
}

async function importarEspacios(textoCsv, usuarioId) {
  const filas = parsearCsvEspacios(textoCsv);

  return prisma.$transaction(async (tx) => {
    let pasillosCreados = 0;
    let boxesCreados = 0;

    for (const { pasillo, box } of filas) {
      const pasilloExistente = await tx.pasillo.findUnique({ where: { nombre: pasillo } });
      const pasilloRow = pasilloExistente || (await tx.pasillo.create({ data: { nombre: pasillo } }));
      if (!pasilloExistente) pasillosCreados += 1;

      const boxExistente = await tx.box.findUnique({
        where: { pasilloId_nombre: { pasilloId: pasilloRow.id, nombre: box } },
      });
      if (!boxExistente) {
        await tx.box.create({ data: { nombre: box, pasilloId: pasilloRow.id } });
        boxesCreados += 1;
      }
    }

    await registrar({ usuarioId, accion: 'IMPORT', entidad: 'Espacio', entidadId: 0 }, tx);
    return { totalFilas: filas.length, pasillosCreados, boxesCreados };
  });
}

module.exports = { importarEspacios };
