(function () {
  var rutSpan = document.querySelector('.rut-valor');
  var btnRut = document.getElementById('btn-mostrar-rut');
  if (rutSpan && btnRut) {
    var mostrando = false;
    btnRut.addEventListener('click', function () {
      mostrando = !mostrando;
      rutSpan.textContent = mostrando ? rutSpan.dataset.rut : rutSpan.dataset.rutOculto;
      btnRut.textContent = mostrando ? 'Ocultar' : 'Mostrar';
    });
  }

  var motivoTexto = document.getElementById('motivo-texto');
  var btnMotivo = document.getElementById('btn-motivo-expandir');
  if (motivoTexto && btnMotivo) {
    motivoTexto.classList.add('motivo-texto--truncado');
    requestAnimationFrame(function () {
      if (motivoTexto.scrollHeight > motivoTexto.clientHeight + 2) {
        btnMotivo.hidden = false;
      } else {
        motivoTexto.classList.remove('motivo-texto--truncado');
      }
    });
    btnMotivo.addEventListener('click', function () {
      var expandido = motivoTexto.classList.toggle('motivo-texto--expandido');
      motivoTexto.classList.toggle('motivo-texto--truncado', !expandido);
      btnMotivo.textContent = expandido ? 'Ver menos' : 'Ver más';
    });
  }
})();
