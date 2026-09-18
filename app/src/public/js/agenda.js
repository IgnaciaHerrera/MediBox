(function () {
  document.querySelectorAll('.filtros [name="fecha"], .filtros [name="boxId"], .filtros [name="medicoId"]').forEach(function (campo) {
    campo.addEventListener('change', function () { campo.form.submit(); });
  });

  // El pasillo es un filtro más amplio que el box: al cambiarlo, el box
  // elegido antes puede ya no pertenecer al nuevo pasillo, así que se
  // limpia antes de recargar en vez de arrastrar una combinación inválida.
  var pasilloSelect = document.querySelector('.filtros [name="pasilloId"]');
  var boxSelect = document.querySelector('.filtros [name="boxId"]');
  if (pasilloSelect && boxSelect) {
    pasilloSelect.addEventListener('change', function () {
      boxSelect.value = '';
      pasilloSelect.form.submit();
    });
  }

  var buscador = document.getElementById('agenda-buscador');
  if (buscador) {
    buscador.addEventListener('input', function () {
      var termino = buscador.value.trim().toLowerCase();
      document.querySelectorAll('[data-busqueda]').forEach(function (el) {
        var coincide = el.dataset.busqueda.toLowerCase().indexOf(termino) !== -1;
        el.hidden = termino.length > 0 && !coincide;
      });
    });
  }
})();
