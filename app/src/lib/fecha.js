// Fechas y horas en la zona horaria local del servidor (TZ, definida en
// docker-compose.yml). toISOString() siempre devuelve UTC, así que no sirve
// para saber qué día u hora es "ahora" en la clínica.
function dos(n) {
  return String(n).padStart(2, '0');
}

// "2026-10-03 14:05:09" en hora local.
function isoLocal(fecha = new Date()) {
  const d = new Date(fecha);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

// "2026-10-03": el día de hoy en hora local.
function hoyISO() {
  return isoLocal().slice(0, 10);
}

/**
 * Edad en años cumplidos a una fecha dada. Compara las fechas como texto
 * AAAA-MM-DD, así que no depende de la zona horaria.
 *
 * @param {string} nacimientoISO - fecha de nacimiento, "AAAA-MM-DD".
 * @param {string} [alISO] - fecha de referencia; por omisión, hoy.
 * @returns {number} años cumplidos.
 *
 * Consumidores: services/pacienteService.js (edad del resumen, rango etario
 *   de la exportación seudonimizada).
 */
function edadEnAnios(nacimientoISO, alISO = hoyISO()) {
  const anios = Number(alISO.slice(0, 4)) - Number(nacimientoISO.slice(0, 4));
  return alISO.slice(5) < nacimientoISO.slice(5) ? anios - 1 : anios;
}

/**
 * Muestra una fecha ISO como día-mes-año, el formato de todo lo que ve una
 * persona: "2026-10-03" → "03-10-2026" y "2026-10-03 14:05" → "03-10-2026 14:05".
 * Solo para texto visible; los value de los inputs de fecha siguen en ISO.
 *
 * @param {string} iso - "AAAA-MM-DD", seguido o no de la hora.
 * @returns {string} la misma fecha como "DD-MM-AAAA", con la hora si la traía.
 *
 * Consumidores: app.js (app.locals, todas las vistas), lib/archivoTitular.js
 *   (archivo de acceso y portabilidad), services/recordatorioService.js.
 */
function fechaDMA(iso) {
  return iso.slice(0, 10).split('-').reverse().join('-') + iso.slice(10);
}

module.exports = { isoLocal, hoyISO, edadEnAnios, fechaDMA };
