// Filtro por estado en /espacios: los contadores del encabezado (todos,
// libres, ocupados) muestran solo los boxes de ese estado. La página ya trae
// todos los boxes con su estado, así que se filtra en el navegador sin pedir
// nada al servidor.
(function () {
  var botones = document.querySelectorAll('[data-filtro-boxes]');
  if (botones.length === 0) return;

  var MENSAJES = {
    libre: 'Ningún box libre en este pasillo.',
    ocupado: 'Ningún box ocupado en este pasillo.',
  };

  function aplicar(filtro) {
    botones.forEach(function (boton) {
      boton.setAttribute('aria-pressed', String(boton.dataset.filtroBoxes === filtro));
    });

    document.querySelectorAll('.pasillo-panel').forEach(function (panel) {
      var visibles = 0;
      panel.querySelectorAll('.box-card:not(.box-card--nuevo)').forEach(function (tarjeta) {
        var coincide = filtro === 'todos' || tarjeta.classList.contains('box-card--' + filtro);
        tarjeta.hidden = !coincide;
        if (coincide) visibles += 1;
      });

      // Agregar un box no tiene sentido mientras se mira un subconjunto.
      panel.querySelectorAll('.box-card--nuevo').forEach(function (tarjeta) {
        tarjeta.hidden = filtro !== 'todos';
      });

      var grilla = panel.querySelector('.boxes-grid');
      var mensaje = panel.querySelector('[data-sin-coincidencias]');
      var sinCoincidencias = filtro !== 'todos' && visibles === 0;
      if (grilla) grilla.hidden = sinCoincidencias;
      if (mensaje) {
        mensaje.textContent = MENSAJES[filtro] || '';
        mensaje.hidden = !sinCoincidencias;
      }
    });

    var agregarPasillo = document.querySelector('.pasillo-head--nuevo');
    if (agregarPasillo) agregarPasillo.hidden = filtro !== 'todos';
  }

  botones.forEach(function (boton) {
    boton.addEventListener('click', function () {
      aplicar(boton.dataset.filtroBoxes);
    });
  });
})();
