(function () {
  var medicoSel = document.getElementById('medicoId');
  var boxSel = document.getElementById('boxId');
  var fechaInput = document.getElementById('fecha');
  var horaInicioInput = document.getElementById('horaInicio');
  var horaFinInput = document.getElementById('horaFin');
  var avisoConflicto = document.getElementById('aviso-conflicto');

  if (!medicoSel || !boxSel || !fechaInput || !horaInicioInput || !horaFinInput || !avisoConflicto) return;

  horaInicioInput.addEventListener('change', function () {
    if (horaInicioInput.value && !horaFinInput.value) {
      var partes = horaInicioInput.value.split(':').map(Number);
      var totalMin = partes[0] * 60 + partes[1] + 30;
      var hh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
      var mm = String(totalMin % 60).padStart(2, '0');
      horaFinInput.value = hh + ':' + mm;
    }
    verificarConflicto();
  });

  [medicoSel, boxSel, fechaInput, horaFinInput].forEach(function (el) {
    el.addEventListener('change', verificarConflicto);
  });

  var temporizador = null;
  function verificarConflicto() {
    if (!medicoSel.value || !boxSel.value || !fechaInput.value || !horaInicioInput.value || !horaFinInput.value) {
      avisoConflicto.hidden = true;
      return;
    }
    clearTimeout(temporizador);
    temporizador = setTimeout(function () {
      var params = new URLSearchParams({
        medicoId: medicoSel.value,
        boxId: boxSel.value,
        fecha: fechaInput.value,
        horaInicio: horaInicioInput.value,
        horaFin: horaFinInput.value,
      });
      fetch('/api/citas/conflicto?' + params.toString())
        .then(function (r) { return r.ok ? r.json() : { conflicto: false }; })
        .then(function (data) { avisoConflicto.hidden = !data.conflicto; })
        .catch(function () { avisoConflicto.hidden = true; });
    }, 300);
  }
})();
