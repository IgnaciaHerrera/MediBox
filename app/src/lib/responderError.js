const { URL } = require('url');
const { toast } = require('./toast');

// Responde un error según quién hizo la petición:
// - el navegador navegando a una vista (GET que pide HTML): página de error;
// - un formulario de una vista (POST que pide HTML): vuelve a la página
//   anterior con un toast rojo;
// - la API, los fetch de los scripts y los tests: el JSON de siempre.
function pideHtml(req) {
  return !req.originalUrl.startsWith('/api') && req.accepts(['json', 'html']) === 'html';
}

// Solo se vuelve a una página de este mismo sitio; cualquier otro Referer
// (o ninguno) lleva al panel.
function paginaAnterior(req) {
  try {
    const url = new URL(req.get('Referer'));
    if (url.host === req.get('host')) return url.pathname + url.search;
  } catch {
    // Referer ausente o inválido.
  }
  return '/dashboard';
}

function responderError(req, res, status, mensaje) {
  if (!pideHtml(req)) return res.status(status).json({ error: mensaje });

  if (req.method !== 'GET') {
    toast(req, status >= 500 ? 'Algo salió mal. Intenta de nuevo.' : mensaje, 'error');
    return res.redirect(paginaAnterior(req));
  }

  return res.status(status).render('error', {
    titulo: status === 403 ? 'Sin permiso' : 'Error',
    usuario: req.usuario,
    csrfToken: res.locals.csrfToken,
    status,
    mensaje,
  });
}

module.exports = { responderError };
