const { AppError } = require('../lib/AppError');
const { logger } = require('../lib/logger');
const { responderError } = require('../lib/responderError');

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return responderError(req, res, err.statusCode, err.message);
  }

  logger.error({ err }, 'Unhandled error');
  return responderError(req, res, 500, 'Error interno del servidor');
}

module.exports = { errorHandler };
