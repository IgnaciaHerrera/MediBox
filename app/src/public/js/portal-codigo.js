// Campo del código del portal: deja solo dígitos (máximo 6), pinta de verde los
// tramos ya escritos y confirma cuando está completo. Es solo ayuda visual: el
// formulario se envía igual y el servidor valida el código.
(function () {
  var form = document.querySelector('[data-portal-codigo]');
  if (!form) return;

  // Entrar al portal siempre empieza en el Resumen: se olvida la sección que
  // Mis datos recordaba de una visita anterior.
  try { window.sessionStorage.removeItem('portal-pestana'); } catch (e) { /* sin almacenamiento */ }

  var input = form.querySelector('.portal-codigo-input');
  var campo = form.querySelector('.portal-codigo');
  var ayuda = form.querySelector('.portal-rut-ayuda');
  var TEXTO_INICIAL = ayuda.textContent;
  var LARGO = 6;

  function actualizar() {
    var digitos = input.value.replace(/\D/g, '').slice(0, LARGO);
    input.value = digitos;
    campo.style.setProperty('--n', String(digitos.length));
    var completo = digitos.length === LARGO;
    campo.dataset.estado = completo ? 'completo' : 'escribiendo';
    ayuda.textContent = completo ? 'Código completo.' : TEXTO_INICIAL;
  }

  input.addEventListener('input', actualizar);
  actualizar();
})();
