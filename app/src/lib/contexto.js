const { AsyncLocalStorage } = require('async_hooks');

// Contexto de la petición en curso, disponible en cualquier punto de la
// cadena sin pasarlo por parámetro. Lo usa la auditoría para saber desde qué
// IP se hizo cada acción sin cambiar la firma de todos los servicios.
const almacen = new AsyncLocalStorage();

/**
 * Ejecuta una función dentro de un contexto.
 *
 * @param {{ip: (string|null)}} contexto
 * @param {Function} fn
 * @returns {*} lo que devuelva fn.
 *
 * Consumidores: middleware(), tests/unit/auditService.test.js.
 */
function ejecutar(contexto, fn) {
  return almacen.run(contexto, fn);
}

/**
 * Middleware de Express: abre el contexto con la IP de la petición. Sin
 * `trust proxy`, req.ip es la del cliente que se conecta directo (o la del
 * proxy, si algún día se pone uno delante): ver README.
 *
 * Consumidores: app.js.
 */
function middleware(req, res, next) {
  ejecutar({ ip: req.ip || null }, next);
}

/**
 * @returns {(string|null)} IP de la petición en curso; null fuera de una
 *   petición (procesos del sistema).
 *
 * Consumidores: services/auditService.registrar().
 */
function ipActual() {
  const contexto = almacen.getStore();
  return contexto ? contexto.ip : null;
}

module.exports = { ejecutar, middleware, ipActual };
