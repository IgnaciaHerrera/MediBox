(function () {
  document.querySelectorAll('.filtros [name="desde"], .filtros [name="hasta"], .filtros [name="accion"], .filtros [name="entidad"], .filtros [name="usuarioId"]').forEach(function (campo) {
    campo.addEventListener('change', function () { campo.form.submit(); });
  });

  document.querySelectorAll('.fila-auditoria').forEach(function (fila) {
    function alternar() {
      var detalle = fila.nextElementSibling;
      if (detalle && detalle.classList.contains('fila-detalle')) {
        detalle.hidden = !detalle.hidden;
      }
    }
    fila.addEventListener('click', alternar);
    fila.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter' || evento.key === ' ') {
        evento.preventDefault();
        alternar();
      }
    });
  });
})();
