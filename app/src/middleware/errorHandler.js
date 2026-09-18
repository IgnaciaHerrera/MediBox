const { AppError } = require('../lib/AppError');
const { logger } = require('../lib/logger');

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({ error: 'Error interno del servidor' });
}

module.exports = { errorHandler };
