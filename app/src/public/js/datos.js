// Pestañas Exportar / Importar en /datos. Sin JavaScript se ven ambas
// secciones una bajo la otra; con él, solo la pestaña activa. La pestaña
// inicial la decide el servidor (aria-selected), y se recuerda en el hash
// de la URL para que recargar no cambie de pestaña.
(function () {
  var pestanas = document.querySelectorAll('[data-pestana]');
  if (pestanas.length === 0) return;

  function mostrar(nombre, enfocar) {
    pestanas.forEach(function (pestana) {
      var activa = pestana.dataset.pestana === nombre;
      pestana.setAttribute('aria-selected', String(activa));
      pestana.tabIndex = activa ? 0 : -1;
      if (activa && enfocar) pestana.focus();
    });
    document.querySelectorAll('[data-panel]').forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== nombre;
    });
  }

  var desdeHash = window.location.hash.replace('#', '');
  var inicial = document.querySelector('[data-pestana][aria-selected="true"]');
  var valida = document.querySelector('[data-pestana="' + desdeHash + '"]');
  mostrar(valida && !document.querySelector('[role="alert"], [role="status"].aviso-exito') ? desdeHash : inicial.dataset.pestana, false);

  pestanas.forEach(function (pestana, indice) {
    pestana.addEventListener('click', function () {
      mostrar(pestana.dataset.pestana, false);
      history.replaceState(null, '', '#' + pestana.dataset.pestana);
    });
    // Flechas izquierda/derecha para moverse entre pestañas (patrón ARIA).
    pestana.addEventListener('keydown', function (evento) {
      if (evento.key !== 'ArrowRight' && evento.key !== 'ArrowLeft') return;
      var paso = evento.key === 'ArrowRight' ? 1 : -1;
      var siguiente = pestanas[(indice + paso + pestanas.length) % pestanas.length];
      mostrar(siguiente.dataset.pestana, true);
      history.replaceState(null, '', '#' + siguiente.dataset.pestana);
    });
  });
})();
