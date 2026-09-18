(function () {
  var panel = document.getElementById('instrumentos-panel');
  if (!panel) return;

  var boxId = panel.dataset.boxId;
  var csrfToken = panel.dataset.csrf;
  var tabla = document.getElementById('tabla-instrumentos');
  var tbody = document.getElementById('tbody-instrumentos');
  var vacio = document.getElementById('instrumentos-vacio');
  var form = document.getElementById('form-agregar-instrumento');
  var errorEl = document.getElementById('instrumento-error');

  function actualizarVacio() {
    var hayFilas = tbody.children.length > 0;
    vacio.hidden = hayFilas;
    tabla.hidden = !hayFilas;
  }

  function mostrarError(mensaje) {
    if (!errorEl) return;
    errorEl.textContent = mensaje;
    errorEl.hidden = false;
  }

  function crearFila(instrumento) {
    var tr = document.createElement('tr');
    tr.dataset.instrumentoId = instrumento.id;
    tr.className = 'fila-entrando';

    var tdNombre = document.createElement('td');
    tdNombre.className = 'instrumento-nombre';
    tdNombre.textContent = instrumento.nombre;
    tr.appendChild(tdNombre);

    var tdAcciones = document.createElement('td');
    tdAcciones.style.textAlign = 'right';
    var boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'btn-link';
    boton.textContent = 'Quitar';
    boton.addEventListener('click', function () {
      if (window.pedirConfirmacion) {
        window.pedirConfirmacion('¿Quitar este instrumento?', function () { quitar(tr, instrumento.id); });
      } else if (window.confirm('¿Quitar este instrumento?')) {
        quitar(tr, instrumento.id);
      }
    });
    tdAcciones.appendChild(boton);
    tr.appendChild(tdAcciones);

    return tr;
  }

  function quitar(tr, instrumentoId) {
    fetch('/api/boxes/' + boxId + '/instrumentos/' + instrumentoId, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    })
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo quitar el instrumento.');
        tr.classList.add('fila-saliendo');
        tr.addEventListener(
          'animationend',
          function () {
            tr.remove();
            actualizarVacio();
          },
          { once: true },
        );
      })
      .catch(function (err) {
        mostrarError(err.message);
      });
  }

  // Los botones "Quitar" ya renderizados por el servidor viven dentro de un
  // <form> con data-confirmar (confirmar.js abre el modal); una vez
  // confirmado, ese mismo formulario vuelve a disparar submit con
  // dataset.confirmado = 'si' — este handler intercepta justo ese segundo
  // submit para hacer la baja sin recargar, en vez de dejarlo navegar.
  document.querySelectorAll('.form-quitar-instrumento').forEach(function (formQuitar) {
    formQuitar.addEventListener('submit', function (evento) {
      evento.preventDefault();
      if (formQuitar.dataset.confirmado !== 'si') return;
      var tr = formQuitar.closest('tr');
      quitar(tr, tr.dataset.instrumentoId);
    });
  });

  if (form) {
    form.addEventListener('submit', function (evento) {
      evento.preventDefault();
      if (errorEl) errorEl.hidden = true;

      var input = document.getElementById('nombreInstrumento');
      var nombre = input.value.trim();
      if (!nombre) return;

      fetch('/api/boxes/' + boxId + '/instrumentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ nombre: nombre }),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (data) { throw new Error(data.error || 'No se pudo agregar el instrumento.'); });
          return r.json();
        })
        .then(function (instrumento) {
          tbody.appendChild(crearFila(instrumento));
          actualizarVacio();
          input.value = '';
          input.focus();
        })
        .catch(function (err) {
          mostrarError(err.message);
        });
    });
  }
})();
