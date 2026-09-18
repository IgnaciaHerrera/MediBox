// Componente genérico "vista ↔ formulario en línea", reutilizado en /espacios
// (renombrar pasillo, crear/editar box) y en /medicos (crear/editar médico,
// renombrar especialidad): cada unidad marcada con data-toggle-editar
// contiene contenido de vista (data-toggle-vista) y un formulario
// (data-toggle-formulario) que se intercambian al presionar el botón de
// activar/cancelar.
(function () {
  document.querySelectorAll('[data-toggle-editar]').forEach(function (unidad) {
    var vista = unidad.querySelectorAll('[data-toggle-vista]');
    var formulario = unidad.querySelectorAll('[data-toggle-formulario]');
    var activar = unidad.querySelector('[data-toggle-activar]');
    var cancelar = unidad.querySelector('[data-toggle-cancelar]');
    var primerCampo = unidad.querySelector(
      'input[data-toggle-formulario], select[data-toggle-formulario], textarea[data-toggle-formulario], '
        + '[data-toggle-formulario] input, [data-toggle-formulario] select, [data-toggle-formulario] textarea',
    );
    if (!activar || !cancelar || vista.length === 0 || formulario.length === 0) return;

    function activarEdicion() {
      vista.forEach(function (el) { el.hidden = true; });
      formulario.forEach(function (el) { el.hidden = false; });
      if (primerCampo) {
        primerCampo.focus();
        if (typeof primerCampo.select === 'function') primerCampo.select();
      }
    }

    function cancelarEdicion() {
      unidad.querySelectorAll('form[data-toggle-formulario]').forEach(function (form) { form.reset(); });
      formulario.forEach(function (el) { el.hidden = true; });
      vista.forEach(function (el) { el.hidden = false; });
    }

    activar.addEventListener('click', activarEdicion);
    cancelar.addEventListener('click', cancelarEdicion);
    unidad.addEventListener('keydown', function (evento) {
      if (evento.key === 'Escape') cancelarEdicion();
    });
  });
})();
