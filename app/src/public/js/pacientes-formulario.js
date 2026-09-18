(function () {
  function limpiarRut(valor) {
    return valor.replace(/[^0-9kK]/g, '').toUpperCase();
  }

  function formatearRut(valor) {
    var limpio = limpiarRut(valor);
    if (limpio.length <= 1) return limpio;
    return limpio.slice(0, -1) + '-' + limpio.slice(-1);
  }

  function calcularDV(cuerpo) {
    var suma = 0;
    var multiplo = 2;
    for (var i = cuerpo.length - 1; i >= 0; i--) {
      suma += parseInt(cuerpo[i], 10) * multiplo;
      multiplo = multiplo === 7 ? 2 : multiplo + 1;
    }
    var resto = 11 - (suma % 11);
    if (resto === 11) return '0';
    if (resto === 10) return 'K';
    return String(resto);
  }

  function rutValido(valor) {
    var limpio = limpiarRut(valor);
    if (limpio.length < 2) return false;
    var cuerpo = limpio.slice(0, -1);
    var dv = limpio.slice(-1);
    return /^[0-9]+$/.test(cuerpo) && calcularDV(cuerpo) === dv;
  }

  var rutInput = document.getElementById('rut');
  var rutAyuda = document.getElementById('rut-ayuda');
  if (rutInput && rutAyuda) {
    rutInput.addEventListener('input', function () {
      rutInput.value = formatearRut(rutInput.value);
      rutAyuda.hidden = true;
      rutInput.classList.remove('field-invalido');
      rutInput.removeAttribute('aria-invalid');
    });
    rutInput.addEventListener('blur', function () {
      if (rutInput.value && !rutValido(rutInput.value)) {
        rutAyuda.hidden = false;
        rutInput.classList.add('field-invalido');
        rutInput.setAttribute('aria-invalid', 'true');
      } else {
        rutAyuda.hidden = true;
        rutInput.classList.remove('field-invalido');
        rutInput.removeAttribute('aria-invalid');
      }
    });
  }

  var contactoInput = document.getElementById('contacto');
  if (contactoInput) {
    contactoInput.addEventListener('input', function () {
      contactoInput.value = contactoInput.value.replace(/[^0-9+\s()-]/g, '');
    });
  }

  var form = document.querySelector('.form-card');
  if (form) {
    form.addEventListener('submit', function () {
      var boton = form.querySelector('button[type="submit"]');
      if (boton && !boton.disabled) {
        boton.disabled = true;
        boton.dataset.textoOriginal = boton.textContent;
        boton.textContent = 'Guardando…';
      }
    });
  }
})();
