// Campo de RUT del portal: le da formato mientras se escribe, llena la línea
// de abajo según el avance y confirma el dígito verificador. Es solo ayuda
// visual: el formulario se envía igual y el servidor decide. Un dígito que no
// coincide no se marca como error, porque el portal acepta también los RUT
// registrados antes de validar ese dígito.
(function () {
  var form = document.querySelector('[data-portal-rut]');
  if (!form) return;

  // Entrar al portal siempre empieza en el Resumen: se olvida la sección que
  // Mis datos recordaba de una visita anterior.
  try { window.sessionStorage.removeItem('portal-pestana'); } catch (e) { /* sin almacenamiento */ }

  var input = form.querySelector('.portal-rut-input');
  var campo = form.querySelector('.portal-rut');
  var ayuda = form.querySelector('.portal-rut-ayuda');
  var TEXTO_INICIAL = ayuda.textContent;
  var TAMANO_COMPLETO = 9; // 8 dígitos + dígito verificador

  function limpiar(texto) {
    return texto.replace(/[^0-9kK]/g, '').toUpperCase().slice(0, TAMANO_COMPLETO);
  }

  // 12345678K -> 12.345.678-K
  function formatear(crudo) {
    if (crudo.length < 2) return crudo;
    var cuerpo = crudo.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return cuerpo + '-' + crudo.slice(-1);
  }

  function digitoVerificador(cuerpo) {
    var suma = 0;
    var factor = 2;
    for (var i = cuerpo.length - 1; i >= 0; i -= 1) {
      suma += Number(cuerpo[i]) * factor;
      factor = factor === 7 ? 2 : factor + 1;
    }
    var resto = 11 - (suma % 11);
    if (resto === 11) return '0';
    if (resto === 10) return 'K';
    return String(resto);
  }

  function esValido(crudo) {
    if (crudo.length < 8) return false;
    var cuerpo = crudo.slice(0, -1);
    return /^\d+$/.test(cuerpo) && digitoVerificador(cuerpo) === crudo.slice(-1);
  }

  function pintar(estado, crudo) {
    var avance = estado === 'valido' ? 1 : Math.min(crudo.length / TAMANO_COMPLETO, 1);
    campo.style.setProperty('--avance', String(avance));
    campo.dataset.estado = estado;
    ayuda.textContent = estado === 'valido' ? 'Dígito verificador correcto.' : TEXTO_INICIAL;
  }

  function actualizar() {
    var crudo = limpiar(input.value);
    input.value = formatear(crudo);
    var estado = 'vacio';
    if (crudo.length > 0) estado = 'escribiendo';
    if (esValido(crudo)) estado = 'valido';
    pintar(estado, crudo);
  }

  input.addEventListener('input', actualizar);
  actualizar();
})();
