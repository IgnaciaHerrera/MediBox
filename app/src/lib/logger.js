const pino = require('pino');

/**
 * Serializa un error para el log sin los datos que trae dentro. Los errores
 * de Prisma copian en su mensaje (y en su stack) los argumentos de la consulta
 * que falló: el nombre, el correo y el hash de la contraseña de una cuenta, o
 * el término de una búsqueda. De ellos solo queda el tipo, el código, el
 * modelo y los campos involucrados (sin sus valores) y los marcos del stack,
 * que dicen dónde falló. El resto de los errores se serializa como siempre.
 *
 * @param {Error} err - el error que se registra en `{ err }`.
 * @returns {object} el error serializado.
 *
 * Consumidores: el logger de este módulo (`serializers.err`), es decir, todo
 *   `logger.error({ err })`: middleware/errorHandler.js y los procesos de
 *   src/ (retencion, recordatorios, alertas, incidente, sesiones, supresiones).
 */
function serializarError(err) {
  const serializado = pino.stdSerializers.err(err);
  if (!serializado || !String(serializado.type).startsWith('PrismaClient')) return serializado;
  return {
    type: serializado.type,
    code: err.code,
    modelo: err.meta?.modelName,
    campos: err.meta?.target,
    stack: String(err.stack || '')
      .split('\n')
      .filter((linea) => linea.trimStart().startsWith('at '))
      .join('\n'),
  };
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  serializers: { err: serializarError },
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

module.exports = { logger, serializadoresHttp, serializarError };
