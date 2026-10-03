// Avisos breves (toasts). El servidor deja uno ya renderizado tras un
// redirect; los scripts que guardan sin recargar usan window.mostrarToast.
(function () {
  var contenedor = document.getElementById('toasts');
  if (!contenedor) return;

  var DURACION = { exito: 4000, error: 7000 };

  function cerrar(toast) {
    if (toast.dataset.cerrando) return;
    toast.dataset.cerrando = 'si';
    toast.classList.add('toast--saliendo');
    setTimeout(function () { toast.remove(); }, 220);
  }

  function activar(toast) {
    var tipo = toast.classList.contains('toast--error') ? 'error' : 'exito';
    var restante = DURACION[tipo];
    var inicio;
    var temporizador;

    function correr() {
      inicio = Date.now();
      temporizador = setTimeout(function () { cerrar(toast); }, restante);
    }

    // Mientras el mouse está encima el aviso no se va.
    toast.addEventListener('mouseenter', function () {
      clearTimeout(temporizador);
      restante -= Date.now() - inicio;
    });
    toast.addEventListener('mouseleave', correr);
    toast.querySelector('.toast-cerrar').addEventListener('click', function () { cerrar(toast); });
    correr();
  }

  var ICONOS = {
    exito: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/>',
  };

  window.mostrarToast = function (mensaje, tipo) {
    tipo = tipo === 'error' ? 'error' : 'exito';
    var toast = document.createElement('div');
    toast.className = 'toast toast--' + tipo;
    toast.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
    toast.innerHTML =
      '<span class="toast-icono" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONOS[tipo] + '</svg></span>' +
      '<p class="toast-mensaje"></p>' +
      '<button type="button" class="toast-cerrar" aria-label="Cerrar aviso"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
    toast.querySelector('.toast-mensaje').textContent = mensaje;
    contenedor.appendChild(toast);
    activar(toast);
  };

  contenedor.querySelectorAll('.toast').forEach(activar);
})();
