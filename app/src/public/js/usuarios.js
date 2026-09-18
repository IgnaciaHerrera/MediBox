(function () {
  document.querySelectorAll('[data-cerrar-modal]').forEach(function (boton) {
    boton.addEventListener('click', function () {
      var dialog = boton.closest('dialog');
      if (dialog) dialog.close();
    });
  });

  var dialogCrear = document.getElementById('modal-crear-usuario');
  var btnAbrirCrear = document.getElementById('btn-crear-usuario');
  if (btnAbrirCrear && dialogCrear && typeof dialogCrear.showModal === 'function') {
    btnAbrirCrear.addEventListener('click', function () { dialogCrear.showModal(); });
  }

  // Campo "Perfil de médico": solo tiene sentido cuando el rol elegido es
  // "medico", así que se muestra/oculta en vivo según la selección — igual
  // para el modal de crear y el de editar.
  function conectarCampoMedico(selectRol, campoMedico) {
    if (!selectRol || !campoMedico) return;
    var rolMedicoId = selectRol.dataset.rolMedicoId;
    function actualizar() {
      campoMedico.hidden = !rolMedicoId || selectRol.value !== rolMedicoId;
    }
    selectRol.addEventListener('change', actualizar);
    return actualizar;
  }

  var campoMedicoCrear = document.getElementById('crear-campo-medico');
  var actualizarCampoMedicoCrear = conectarCampoMedico(document.getElementById('crear-rolId'), campoMedicoCrear);

  var dialogEditar = document.getElementById('modal-editar-usuario');
  var formEditar = document.getElementById('form-editar-usuario');
  var campoNombre = document.getElementById('editar-nombre');
  var campoEmail = document.getElementById('editar-email');
  var campoRol = document.getElementById('editar-rolId');
  var campoRolOculto = document.getElementById('editar-rolId-oculto');
  var campoPassword = document.getElementById('editar-nuevaPassword');
  var avisoRol = document.getElementById('editar-aviso-rol');
  var campoMedicoEditar = document.getElementById('editar-campo-medico');
  var selectMedicoEditar = document.getElementById('editar-medicoId');
  var opcionesBaseMedico = selectMedicoEditar ? selectMedicoEditar.innerHTML : '';
  var actualizarCampoMedicoEditar = conectarCampoMedico(campoRol, campoMedicoEditar);

  if (dialogEditar && typeof dialogEditar.showModal === 'function') {
    document.querySelectorAll('.btn-editar-usuario').forEach(function (enlace) {
      enlace.addEventListener('click', function (evento) {
        evento.preventDefault();
        var esUnoMismo = enlace.dataset.esUnoMismo === '1';

        formEditar.action = enlace.getAttribute('href');
        campoNombre.value = enlace.dataset.nombre;
        campoEmail.value = enlace.dataset.email;
        campoRol.value = enlace.dataset.rolId;
        campoRolOculto.value = enlace.dataset.rolId;
        campoRol.disabled = esUnoMismo;
        campoRolOculto.disabled = !esUnoMismo;
        avisoRol.hidden = !esUnoMismo;
        campoPassword.value = '';

        if (selectMedicoEditar) {
          selectMedicoEditar.innerHTML = opcionesBaseMedico;
          if (enlace.dataset.medicoId) {
            var opcion = document.createElement('option');
            opcion.value = enlace.dataset.medicoId;
            opcion.textContent = enlace.dataset.medicoNombre;
            selectMedicoEditar.appendChild(opcion);
            selectMedicoEditar.value = enlace.dataset.medicoId;
          } else {
            selectMedicoEditar.value = '';
          }
        }
        if (actualizarCampoMedicoEditar) actualizarCampoMedicoEditar();

        dialogEditar.showModal();
      });
    });
  }

  var buscador = document.getElementById('usuarios-buscador');
  if (buscador) {
    buscador.addEventListener('input', function () {
      var termino = buscador.value.trim().toLowerCase();
      var filas = document.querySelectorAll('[data-busqueda]');
      var algunaVisible = false;
      filas.forEach(function (fila) {
        var coincide = fila.dataset.busqueda.toLowerCase().indexOf(termino) !== -1;
        fila.hidden = termino.length > 0 && !coincide;
        if (!fila.hidden) algunaVisible = true;
      });
      var sinResultados = document.getElementById('fila-sin-resultados');
      if (sinResultados) sinResultados.hidden = algunaVisible || filas.length === 0;
    });
  }
})();
