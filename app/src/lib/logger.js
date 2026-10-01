const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie'],
});

// Serializadores del log de acceso (pino-http). Por defecto se registraban
// la URL con su query string (las búsquedas de pacientes llevan nombres o
// RUT), todos los encabezados de la petición y los de la respuesta, entre
// ellos la cookie de sesión recién emitida y el token CSRF. Solo se deja lo
// necesario para diagnosticar: qué ruta, quién la pidió y cómo respondió.
const serializadoresHttp = {
  req: (req) => ({
    id: req.id,
    method: req.method,
    ruta: req.url.split('?')[0],
    remoteAddress: req.remoteAddress,
  }),
  res: (res) => ({ statusCode: res.statusCode }),
};

module.exports = { logger, serializadoresHttp };
