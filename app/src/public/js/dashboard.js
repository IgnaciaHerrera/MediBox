(function () {
  var prefiereMenosMovimiento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.querySelectorAll('[data-count-to]').forEach(function (el) {
    var destino = Number(el.dataset.countTo);
    if (prefiereMenosMovimiento || !Number.isFinite(destino)) {
      el.textContent = destino;
      return;
    }

    var duracion = 700;
    var inicio = null;

    function paso(marcaTiempo) {
      if (inicio === null) inicio = marcaTiempo;
      var progreso = Math.min((marcaTiempo - inicio) / duracion, 1);
      var suavizado = 1 - Math.pow(1 - progreso, 3);
      el.textContent = Math.round(destino * suavizado);
      if (progreso < 1) requestAnimationFrame(paso);
    }

    requestAnimationFrame(paso);
  });
})();
