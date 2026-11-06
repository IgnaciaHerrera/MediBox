/**
 * El número de incidente de `--incidente N` en la línea de comandos de un
 * proceso de contención o investigación: con él, la acción aparece en la
 * bitácora de ese incidente. Termina el proceso si N no es un entero.
 *
 * @param {string[]} [argv] - por omisión, process.argv.
 * @returns {(number|null)} el número, o null si no se indicó.
 *
 * Consumidores: src/sesiones.js, src/cuentas.js, src/evidencia.js,
 *   src/incidente.js, src/reconstruir.js.
 */
function incidenteDeArgumentos(argv = process.argv) {
  const i = argv.indexOf('--incidente');
  if (i === -1) return null;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write('--incidente debe ser el número de un incidente\n');
    process.exit(2);
  }
  return n;
}

module.exports = { incidenteDeArgumentos };
