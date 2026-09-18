(function () {
  var dropzone = document.getElementById('dropzone-csv');
  var archivoInput = document.getElementById('archivo-csv');
  var textarea = document.getElementById('csv');
  if (!dropzone || !archivoInput || !textarea) return;

  var MAX_FILAS_VISIBLES = 200;
  var vistaPrevia = document.getElementById('csv-vista-previa');
  var vistaPreviaTotal = document.getElementById('vista-previa-total');
  var vistaPreviaErrores = document.getElementById('vista-previa-errores');
  var vistaPreviaCuerpo = document.getElementById('vista-previa-cuerpo');

  function leerArchivo(archivo) {
    if (!archivo) return;
    var lector = new FileReader();
    lector.onload = function () {
      textarea.value = String(lector.result || '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };
    lector.readAsText(archivo);
  }

  dropzone.addEventListener('click', function () {
    archivoInput.click();
  });

  dropzone.addEventListener('keydown', function (evento) {
    if (evento.key === 'Enter' || evento.key === ' ') {
      evento.preventDefault();
      archivoInput.click();
    }
  });

  archivoInput.addEventListener('change', function () {
    leerArchivo(archivoInput.files[0]);
  });

  ['dragenter', 'dragover'].forEach(function (tipo) {
    dropzone.addEventListener(tipo, function (evento) {
      evento.preventDefault();
      dropzone.classList.add('dropzone--sobre');
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach(function (tipo) {
    dropzone.addEventListener(tipo, function () {
      dropzone.classList.remove('dropzone--sobre');
    });
  });

  dropzone.addEventListener('drop', function (evento) {
    evento.preventDefault();
    var archivos = evento.dataTransfer && evento.dataTransfer.files;
    if (archivos && archivos.length > 0) leerArchivo(archivos[0]);
  });

  // Parseo tolerante en el cliente, solo para la vista previa: la validación
  // real (y la única que importa) sigue ocurriendo en el servidor al enviar
  // el formulario — esto es apenas una ayuda visual antes de confirmar.
  function analizarCsv(texto) {
    var lineas = texto
      .split(/\r?\n/)
      .map(function (linea) { return linea.trim(); })
      .filter(function (linea) { return linea.length > 0; });

    if (lineas.length > 0 && lineas[0].toLowerCase().replace(/\s+/g, '') === 'pasillo,box') {
      lineas.shift();
    }

    return lineas.map(function (linea) {
      var columnas = linea.split(',').map(function (c) { return c.trim(); });
      var valida = columnas.length === 2 && !!columnas[0] && !!columnas[1];
      return { pasillo: columnas[0] || '', box: columnas[1] || '', valida: valida };
    });
  }

  function actualizarVistaPrevia() {
    var texto = textarea.value.trim();
    if (!texto) {
      vistaPrevia.hidden = true;
      return;
    }

    var filas = analizarCsv(texto);
    var invalidas = filas.filter(function (f) { return !f.valida; }).length;

    vistaPreviaTotal.textContent = filas.length === 1 ? '1 fila detectada' : filas.length + ' filas detectadas';
    if (invalidas > 0) {
      vistaPreviaErrores.hidden = false;
      vistaPreviaErrores.textContent = invalidas === 1
        ? '1 línea no tiene el formato "pasillo,box"'
        : invalidas + ' líneas no tienen el formato "pasillo,box"';
    } else {
      vistaPreviaErrores.hidden = true;
    }

    vistaPreviaCuerpo.innerHTML = '';
    filas.slice(0, MAX_FILAS_VISIBLES).forEach(function (fila) {
      var tr = document.createElement('tr');
      if (!fila.valida) tr.className = 'vista-previa-fila--invalida';

      var tdPasillo = document.createElement('td');
      tdPasillo.textContent = fila.pasillo || '—';
      var tdBox = document.createElement('td');
      tdBox.textContent = fila.box || '—';

      tr.appendChild(tdPasillo);
      tr.appendChild(tdBox);
      vistaPreviaCuerpo.appendChild(tr);
    });

    if (filas.length > MAX_FILAS_VISIBLES) {
      var trResto = document.createElement('tr');
      var tdResto = document.createElement('td');
      tdResto.colSpan = 2;
      tdResto.className = 'vista-previa-resto';
      tdResto.textContent = '+ ' + (filas.length - MAX_FILAS_VISIBLES) + ' fila(s) más';
      trResto.appendChild(tdResto);
      vistaPreviaCuerpo.appendChild(trResto);
    }

    vistaPrevia.hidden = false;
  }

  textarea.addEventListener('input', actualizarVistaPrevia);
  actualizarVistaPrevia();
})();
