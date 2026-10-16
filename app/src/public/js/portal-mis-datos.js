// Mis datos (portal del paciente): una sección a la vez, elegida en el menú de
// la barra superior. Sin JavaScript se ven todas las secciones una bajo la
// otra y los enlaces del menú llevan a cada una. La sección abierta se
// recuerda en el hash y en sessionStorage, porque cada acción (aceptar,
// revocar, solicitar) recarga la página y no debe volver al inicio.
(function () {
  var raiz = document.querySelector('[data-portal-datos]');
  if (!raiz) return;

  var enlaces = [].slice.call(document.querySelectorAll('.topbar-nav [data-pestana]'));
  var paneles = [].slice.call(raiz.querySelectorAll('[data-panel]'));
  var CLAVE = 'portal-pestana';

  function recordar(nombre) {
    try { window.sessionStorage.setItem(CLAVE, nombre); } catch (e) { /* sin almacenamiento */ }
  }

  function recordada() {
    try { return window.sessionStorage.getItem(CLAVE); } catch (e) { return null; }
  }

  function existe(nombre) {
    return enlaces.some(function (a) { return a.dataset.pestana === nombre; });
  }

  function mostrar(nombre, subir) {
    enlaces.forEach(function (a) {
      var activa = a.dataset.pestana === nombre;
      a.classList.toggle('activo', activa);
      if (activa) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    });
    paneles.forEach(function (panel) { panel.hidden = panel.dataset.panel !== nombre; });
    recordar(nombre);
    if (subir) window.scrollTo(0, 0);
    // En pantallas angostas el menú es un panel lateral: se cierra al elegir.
    var cerrar = document.querySelector('.topbar.abierto [data-topbar-cerrar]');
    if (cerrar) cerrar.click();
  }

  function ir(nombre) {
    mostrar(nombre, true);
    window.history.replaceState(null, '', '#' + nombre);
  }

  var desdeHash = window.location.hash.replace('#', '');
  var inicial = existe(desdeHash) ? desdeHash : (existe(recordada()) ? recordada() : enlaces[0].dataset.pestana);
  mostrar(inicial, false);

  // Atrás/adelante del navegador o un hash escrito a mano.
  window.addEventListener('hashchange', function () {
    var nombre = window.location.hash.replace('#', '');
    if (existe(nombre)) mostrar(nombre, true);
  });

  // Menú y enlaces internos ("Pide corregirlo", "Ver todas mis citas").
  [].slice.call(document.querySelectorAll('[data-pestana], [data-ir]')).forEach(function (enlace) {
    enlace.addEventListener('click', function (evento) {
      evento.preventDefault();
      ir(enlace.dataset.pestana || enlace.dataset.ir);
    });
  });

  // Listas largas (citas): de a 10 por página, con Anterior / Siguiente. Sin
  // JavaScript se ven todas. El pie solo aparece si hay más de una página.
  [].slice.call(raiz.querySelectorAll('[data-paginar]')).forEach(function (lista) {
    var filas = [].slice.call(lista.querySelectorAll('tbody tr'));
    var porPagina = Number(lista.dataset.paginar) || 10;
    var pie = lista.querySelector('[data-paginacion]');
    if (!pie || filas.length <= porPagina) return;

    var anterior = pie.querySelector('[data-pagina-anterior]');
    var siguiente = pie.querySelector('[data-pagina-siguiente]');
    var info = pie.querySelector('[data-pagina-info]');
    var totalPaginas = Math.ceil(filas.length / porPagina);
    var pagina = 1;

    function pintar() {
      filas.forEach(function (fila, i) {
        fila.hidden = Math.floor(i / porPagina) + 1 !== pagina;
      });
      anterior.hidden = pagina === 1;
      siguiente.hidden = pagina === totalPaginas;
      info.textContent = filas.length + ' citas en total — página ' + pagina + ' de ' + totalPaginas;
    }

    anterior.addEventListener('click', function () { pagina -= 1; pintar(); });
    siguiente.addEventListener('click', function () { pagina += 1; pintar(); });
    pie.hidden = false;
    pintar();
  });

  // Solicitud: "dato a corregir" y "valor correcto" solo importan al corregir.
  var solicitud = raiz.querySelector('[data-solicitud]');
  if (solicitud) {
    var elegir = solicitud.querySelector('select[name="derecho"]');
    var extras = [].slice.call(solicitud.querySelectorAll('[data-solo-rectificacion]'));
    var sincronizar = function () {
      var corrige = elegir.value === 'rectificacion';
      extras.forEach(function (bloque) {
        bloque.hidden = !corrige;
        [].slice.call(bloque.querySelectorAll('select, input')).forEach(function (campo) { campo.required = corrige; });
      });
    };
    elegir.addEventListener('change', sincronizar);
    sincronizar();
  }

  // Consentimiento: "Aceptar" se habilita al marcar que leyó el texto.
  [].slice.call(raiz.querySelectorAll('[data-consentimiento]')).forEach(function (formulario) {
    var casilla = formulario.querySelector('input[name="acepto"]');
    var boton = formulario.querySelector('button[type="submit"]');
    var sincronizar = function () { boton.disabled = !casilla.checked; };
    casilla.addEventListener('change', sincronizar);
    sincronizar();
  });
})();
