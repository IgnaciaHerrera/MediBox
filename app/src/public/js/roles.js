(function () {
  var form = document.getElementById('form-matriz');
  var barra = document.getElementById('barra-guardar');
  var barraTexto = document.getElementById('barra-guardar-texto');
  if (!form || !barra || !barraTexto) return;

  function casillas() {
    return Array.prototype.slice.call(form.querySelectorAll('input[type="checkbox"]'));
  }

  function estaModificada(casilla) {
    return casilla.checked !== casilla.defaultChecked;
  }

  function marcarCelda(casilla) {
    var celda = casilla.closest('td');
    if (celda) celda.classList.toggle('celda-modificada', estaModificada(casilla));
  }

  function mostrarBarra() {
    barra.classList.remove('barra-saliendo');
    barra.hidden = false;
  }

  function ocultarBarra() {
    if (barra.hidden) return;
    barra.classList.add('barra-saliendo');
    var yaOculta = false;
    function finalizar() {
      if (yaOculta) return;
      yaOculta = true;
      barra.hidden = true;
      barra.classList.remove('barra-saliendo');
    }
    // Se espera el fin de la animación de salida, pero con un respaldo por
    // temporizador: si el evento no llega (pestaña en segundo plano, otra
    // transición interrumpe la animación, etc.), la barra igual se oculta.
    barra.addEventListener('animationend', finalizar, { once: true });
    setTimeout(finalizar, 200);
  }

  function actualizarBarra() {
    var modificadas = casillas().filter(estaModificada);
    if (modificadas.length === 0) {
      ocultarBarra();
      return;
    }
    barraTexto.textContent = modificadas.length === 1
      ? '1 permiso modificado sin guardar'
      : modificadas.length + ' permisos modificados sin guardar';
    mostrarBarra();
  }

  form.addEventListener('change', function (evento) {
    if (evento.target.matches('input[type="checkbox"]')) marcarCelda(evento.target);
    actualizarBarra();
  });

  form.addEventListener('reset', function () {
    casillas().forEach(marcarCelda);
    ocultarBarra();
  });
})();
