function escaparCampo(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  if (/[",\n]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

function toCsv(encabezados, filas) {
  const lineas = [encabezados.map(escaparCampo).join(',')];
  for (const fila of filas) {
    lineas.push(encabezados.map((clave) => escaparCampo(fila[clave])).join(','));
  }
  return lineas.join('\r\n') + '\r\n';
}

module.exports = { toCsv };
