(function () {
  var modal = document.getElementById('modal-confirmar');
  if (!modal) return;

  var mensajeEl = document.getElementById('modal-confirmar-mensaje');
  var btnConfirmar = modal.querySelector('[data-modal-confirmar]');
  var btnCancelar = modal.querySelector('[data-modal-cancelar]');
  var alConfirmarPendiente = null;

  // API programática, para código que quiera el mismo modal sin depender de
  // un <form data-confirmar> declarativo (p. ej. filas agregadas por JS
  // después de que este script ya corrió su propio querySelectorAll).
  function pedirConfirmacion(mensaje, callback) {
    alConfirmarPendiente = callback;
    mensajeEl.textContent = mensaje;
    modal.showModal();
  }

  document.querySelectorAll('form[data-confirmar]').forEach(function (form) {
    form.addEventListener('submit', function (evento) {
      if (form.dataset.confirmado === 'si') return;
      evento.preventDefault();
      pedirConfirmacion(form.dataset.confirmar, function () {
        form.dataset.confirmado = 'si';
        form.requestSubmit();
      });
    });
  });

  btnConfirmar.addEventListener('click', function () {
    modal.close();
    var callback = alConfirmarPendiente;
    alConfirmarPendiente = null;
    if (callback) callback();
  });

  btnCancelar.addEventListener('click', function () {
    modal.close();
    alConfirmarPendiente = null;
  });

  modal.addEventListener('cancel', function () {
    alConfirmarPendiente = null;
  });

  window.pedirConfirmacion = pedirConfirmacion;
})();
