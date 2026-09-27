(function () {
  var buscador = document.getElementById('q');
  var resultados = document.getElementById('pacientes-resultados');
  var limpiar = document.querySelector('[data-buscador-limpiar]');
  if (!buscador || !resultados) return;

  // La búsqueda la hace el servidor (hay paginación), así que se pide la
  // misma página con ?q= y se reemplaza solo el bloque de resultados, sin
  // recargar ni perder el foco del campo. Espera a que se deje de escribir.
  var espera;
  var ultimaPedida = 0;

  function buscar() {
    var termino = buscador.value.trim();
    var url = '/pacientes' + (termino ? '?q=' + encodeURIComponent(termino) : '');
    var pedido = ++ultimaPedida;

    fetch(url, { headers: { Accept: 'text/html' } })
      .then(function (respuesta) { return respuesta.text(); })
      .then(function (html) {
        // Si llegó una respuesta vieja después de una más nueva, se ignora.
        if (pedido !== ultimaPedida) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nuevos = doc.getElementById('pacientes-resultados');
        if (nuevos) resultados.innerHTML = nuevos.innerHTML;
        history.replaceState(null, '', url);
      });
  }

  buscador.addEventListener('input', function () {
    limpiar.hidden = buscador.value.length === 0;
    clearTimeout(espera);
    espera = setTimeout(buscar, 300);
  });

  buscador.form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    clearTimeout(espera);
    buscar();
  });

  limpiar.addEventListener('click', function () {
    buscador.value = '';
    buscador.dispatchEvent(new Event('input'));
    buscador.focus();
  });
})();
