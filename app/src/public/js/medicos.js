(function () {
  var filtro = document.querySelector('.filtros [name="especialidadId"]');
  if (filtro) {
    filtro.addEventListener('change', function () { filtro.form.submit(); });
  }
})();
