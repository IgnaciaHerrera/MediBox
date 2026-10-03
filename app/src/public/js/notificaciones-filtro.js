// Filtro "Todas / No leídas" de /notificaciones. No toca la lógica de marcar
// como leída (notificaciones.js): observa los cambios de clase que ese
// script hace en cada .notif-item y con eso actualiza el contador y la lista.
(function () {
  var lista = document.getElementById('lista-notificaciones');
  var botones = document.querySelectorAll('[data-filtro-notif]');
  if (!lista || botones.length === 0) return;

  var conteoNoLeidas = document.querySelector('[data-conteo-no-leidas]');
  var sinPendientes = document.querySelector('[data-notif-sin-pendientes]');
  var filtro = 'todas';

  function aplicar() {
    var pendientes = 0;
    lista.querySelectorAll('.notif-item').forEach(function (item) {
      var leida = item.classList.contains('notif-item--leida');
      if (!leida) pendientes += 1;
      item.hidden = filtro === 'no-leidas' && leida;
    });

    // Un día sin notificaciones visibles no muestra su encabezado.
    lista.querySelectorAll('.notif-grupo').forEach(function (grupo) {
      grupo.hidden = !grupo.querySelector('.notif-item:not([hidden])');
    });

    if (conteoNoLeidas) conteoNoLeidas.textContent = String(pendientes);
    if (sinPendientes) sinPendientes.hidden = !(filtro === 'no-leidas' && pendientes === 0);
  }

  botones.forEach(function (boton) {
    boton.addEventListener('click', function () {
      filtro = boton.dataset.filtroNotif;
      botones.forEach(function (b) { b.setAttribute('aria-pressed', String(b === boton)); });
      aplicar();
    });
  });

  new window.MutationObserver(aplicar).observe(lista, { subtree: true, attributes: true, attributeFilter: ['class'] });
})();
