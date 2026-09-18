(function () {
  var lista = document.getElementById('lista-notificaciones');
  if (!lista) return;
  var csrfToken = lista.dataset.csrf;

  function actualizarBadge(delta) {
    var badge = document.querySelector('.topbar-badge');
    if (!badge) return;
    // Si ya muestra "9+" no se puede decrementar con precisión desde acá;
    // se deja como está y se corrige solo en la próxima carga de página.
    if (badge.textContent.indexOf('+') !== -1) return;
    var nuevo = (parseInt(badge.textContent, 10) || 0) + delta;
    if (nuevo <= 0) {
      badge.remove();
    } else {
      badge.textContent = nuevo > 9 ? '9+' : String(nuevo);
    }
  }

  document.querySelectorAll('.form-marcar-leida').forEach(function (form) {
    form.addEventListener('submit', function (evento) {
      evento.preventDefault();
      var item = form.closest('.notif-item');
      fetch(form.action.replace('/notificaciones/', '/api/notificaciones/'), {
        method: 'PATCH',
        headers: { 'X-CSRF-Token': csrfToken },
      })
        .then(function (r) {
          if (!r.ok) throw new Error('No se pudo marcar como leída');
          item.classList.add('notif-item--leida');
          form.remove();
          actualizarBadge(-1);
        })
        .catch(function () {
          // Si falla el fetch, se deja el formulario intacto: un segundo
          // clic simplemente reintenta la misma acción.
        });
    });
  });

  var formTodas = document.getElementById('form-marcar-todas');
  if (formTodas) {
    formTodas.addEventListener('submit', function (evento) {
      evento.preventDefault();
      fetch('/api/notificaciones/marcar-todas', {
        method: 'PATCH',
        headers: { 'X-CSRF-Token': csrfToken },
      })
        .then(function (r) {
          if (!r.ok) throw new Error('No se pudo marcar todas como leídas');
          document.querySelectorAll('.notif-item').forEach(function (item) {
            item.classList.add('notif-item--leida');
            var boton = item.querySelector('.form-marcar-leida');
            if (boton) boton.remove();
          });
          formTodas.remove();
          var badge = document.querySelector('.topbar-badge');
          if (badge) badge.remove();
        })
        .catch(function () {});
    });
  }
})();
