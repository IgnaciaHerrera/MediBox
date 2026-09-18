const auditService = require('../services/auditService');

async function index(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    res.json(await auditService.listar({ page, pageSize }));
  } catch (err) {
    next(err);
  }
}

module.exports = { index };
