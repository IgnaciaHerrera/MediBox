// Aviso breve ("toast") que se muestra en la próxima página que se renderice.
// Se guarda en la sesión justo antes de un redirect y el middleware
// `pasarToastAVista` lo entrega a la vista una sola vez.
function toast(req, mensaje, tipo = 'exito') {
  if (req.session) req.session.toast = { mensaje, tipo };
}

function pasarToastAVista(req, res, next) {
  if (req.session && req.session.toast) {
    res.locals.toast = req.session.toast;
    delete req.session.toast;
  }
  next();
}

module.exports = { toast, pasarToastAVista };
