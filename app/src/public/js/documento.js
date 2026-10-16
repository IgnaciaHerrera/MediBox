// Índice de un documento (política de privacidad): marca en la lista la sección
// que se está leyendo. Sin JavaScript el índice funciona igual, solo que sin
// marcar la sección actual.
(function () {
  var enlaces = [].slice.call(document.querySelectorAll('.doc-indice a'));
  var secciones = [].slice.call(document.querySelectorAll('.doc-seccion'));
  if (enlaces.length === 0 || secciones.length === 0 || !('IntersectionObserver' in window)) return;

  function marcar(id) {
    enlaces.forEach(function (a) {
      if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }

  // Una sección cuenta como la actual cuando cruza el tercio superior de la pantalla.
  var observador = new window.IntersectionObserver(
    function (entradas) {
      entradas.forEach(function (entrada) {
        if (entrada.isIntersecting) marcar(entrada.target.id);
      });
    },
    { rootMargin: '-15% 0px -70% 0px' },
  );

  secciones.forEach(function (seccion) { observador.observe(seccion); });
  marcar(secciones[0].id);
})();
