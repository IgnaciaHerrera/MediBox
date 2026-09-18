(function () {
  document.querySelectorAll('[data-combobox]').forEach(function (contenedor) {
    var input = contenedor.querySelector('input[type="text"]');
    var campoOculto = contenedor.querySelector('input[type="hidden"]');
    var lista = contenedor.querySelector('.combobox-lista');
    var datos = [];
    try {
      datos = JSON.parse(contenedor.querySelector('script[type="application/json"]').textContent);
    } catch (e) {
      datos = [];
    }

    function render(filtro) {
      lista.innerHTML = '';
      var termino = filtro.trim().toLowerCase();
      var coincidencias = datos
        .filter(function (item) { return item.etiqueta.toLowerCase().indexOf(termino) !== -1; })
        .slice(0, 50);

      if (coincidencias.length === 0) {
        var vacio = document.createElement('div');
        vacio.className = 'combobox-sin-resultados';
        vacio.textContent = 'Sin resultados';
        lista.appendChild(vacio);
        return;
      }

      coincidencias.forEach(function (item) {
        var opcion = document.createElement('div');
        opcion.className = 'combobox-opcion';
        opcion.textContent = item.etiqueta;
        opcion.addEventListener('mousedown', function (evento) {
          evento.preventDefault();
          input.value = item.etiqueta;
          campoOculto.value = item.id;
          campoOculto.dispatchEvent(new Event('change'));
          lista.hidden = true;
        });
        lista.appendChild(opcion);
      });
    }

    input.addEventListener('focus', function () {
      render(input.value);
      lista.hidden = false;
    });

    input.addEventListener('input', function () {
      campoOculto.value = '';
      render(input.value);
      lista.hidden = false;
    });

    input.addEventListener('blur', function () {
      setTimeout(function () {
        lista.hidden = true;
        if (!campoOculto.value) input.value = '';
      }, 150);
    });
  });
})();
