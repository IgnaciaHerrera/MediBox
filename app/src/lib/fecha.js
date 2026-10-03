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

module.exports = { isoLocal, hoyISO };
