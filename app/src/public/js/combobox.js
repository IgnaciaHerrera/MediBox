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

    var indiceActivo = -1;
    var opcionesActuales = [];

    function idOpcion(i) {
      return lista.id + '-opcion-' + i;
    }

    function seleccionar(item) {
      input.value = item.etiqueta;
      campoOculto.value = item.id;
      campoOculto.dispatchEvent(new Event('change'));
      cerrar();
    }

    function marcarActiva(i) {
      opcionesActuales.forEach(function (el) { el.setAttribute('aria-selected', 'false'); });
      indiceActivo = i;
      if (i >= 0 && opcionesActuales[i]) {
        opcionesActuales[i].setAttribute('aria-selected', 'true');
        opcionesActuales[i].scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', opcionesActuales[i].id);
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function abrir() {
      lista.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function cerrar() {
      lista.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      indiceActivo = -1;
    }

    function render(filtro) {
      lista.innerHTML = '';
      opcionesActuales = [];
      indiceActivo = -1;
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

      coincidencias.forEach(function (item, i) {
        var opcion = document.createElement('div');
        opcion.className = 'combobox-opcion';
        opcion.textContent = item.etiqueta;
        opcion.id = idOpcion(i);
        opcion.setAttribute('role', 'option');
        opcion.setAttribute('aria-selected', 'false');
        // mousedown (no click): dispara antes que el blur del input, así el
        // valor se aplica antes de que blur oculte la lista y borre el texto.
        opcion.addEventListener('mousedown', function (evento) {
          evento.preventDefault();
          seleccionar(item);
        });
        lista.appendChild(opcion);
        opcionesActuales.push(opcion);
      });
    }

    input.addEventListener('focus', function () {
      render(input.value);
      abrir();
    });

    input.addEventListener('input', function () {
      campoOculto.value = '';
      render(input.value);
      abrir();
    });

    input.addEventListener('keydown', function (evento) {
      if (lista.hidden && (evento.key === 'ArrowDown' || evento.key === 'ArrowUp')) {
        render(input.value);
        abrir();
        return;
      }
      if (lista.hidden || opcionesActuales.length === 0) return;

      if (evento.key === 'ArrowDown') {
        evento.preventDefault();
        marcarActiva((indiceActivo + 1) % opcionesActuales.length);
      } else if (evento.key === 'ArrowUp') {
        evento.preventDefault();
        marcarActiva((indiceActivo - 1 + opcionesActuales.length) % opcionesActuales.length);
      } else if (evento.key === 'Enter') {
        if (indiceActivo >= 0) {
          evento.preventDefault();
          var item = datos.find(function (d) { return d.etiqueta === opcionesActuales[indiceActivo].textContent; });
          if (item) seleccionar(item);
        }
      } else if (evento.key === 'Escape') {
        cerrar();
      }
    });

    input.addEventListener('blur', function () {
      setTimeout(function () {
        cerrar();
        if (!campoOculto.value) input.value = '';
      }, 150);
    });
  });
})();
