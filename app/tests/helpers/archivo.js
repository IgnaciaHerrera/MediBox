const { unzipSync, strFromU8 } = require('fflate');

/**
 * Hace que supertest entregue el cuerpo de la respuesta como Buffer (para
 * un .xlsx o un PDF).
 *
 * @param {object} peticion - una petición de supertest, antes de await.
 * @returns {object} la misma petición.
 */
function comoBinario(peticion) {
  return peticion.buffer(true).parse((res, callback) => {
    const partes = [];
    res.on('data', (parte) => partes.push(parte));
    res.on('end', () => callback(null, Buffer.concat(partes)));
  });
}

/**
 * Todo el texto de un .xlsx (los nombres de las hojas y sus celdas), para
 * comprobar qué contiene y qué no.
 *
 * @param {Buffer} contenido - el .xlsx.
 * @returns {string}
 */
function textoDelExcel(contenido) {
  const archivos = unzipSync(new Uint8Array(contenido));
  return Object.keys(archivos)
    .filter((nombre) => nombre.endsWith('.xml'))
    .map((nombre) => strFromU8(archivos[nombre]))
    .join('\n');
}

module.exports = { comoBinario, textoDelExcel };
