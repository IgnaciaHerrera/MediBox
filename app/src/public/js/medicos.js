(function () {
  var filtro = document.querySelector('.filtros [name="especialidadId"]');
  if (filtro) {
    filtro.addEventListener('change', function () { filtro.form.submit(); });
  }

  var buscador = document.getElementById('medicos-buscador');
  if (buscador) {
    // El buscador vive dentro del form de filtros: Enter no debe
    // enviarlo, la búsqueda filtra las tarjetas en el navegador.
    buscador.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter') evento.preventDefault();
    });

    buscador.addEventListener('input', function () {
      var termino = buscador.value.trim().toLowerCase();
      var algunaVisible = false;
      document.querySelectorAll('.medico-card[data-busqueda]').forEach(function (tarjeta) {
        var coincide = tarjeta.dataset.busqueda.toLowerCase().indexOf(termino) !== -1;
        tarjeta.hidden = termino.length > 0 && !coincide;
        if (!tarjeta.hidden) algunaVisible = true;
      });
      document.querySelector('[data-sin-resultados]').hidden = algunaVisible || termino.length === 0;
      limpiar.hidden = buscador.value.length === 0;
    });

    var limpiar = document.querySelector('[data-buscador-limpiar]');
    limpiar.addEventListener('click', function () {
      buscador.value = '';
      buscador.dispatchEvent(new Event('input'));
      buscador.focus();
    });
  }
})();
