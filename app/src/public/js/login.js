document.querySelectorAll('[data-password-toggle]').forEach((boton) => {
  const campo = boton.closest('.password-field').querySelector('input');
  const iconoVisible = boton.querySelector('[data-icon-visible]');
  const iconoOculto = boton.querySelector('[data-icon-hidden]');

  boton.addEventListener('click', () => {
    const mostrando = campo.type === 'text';
    campo.type = mostrando ? 'password' : 'text';
    boton.setAttribute('aria-pressed', String(!mostrando));
    boton.setAttribute('aria-label', mostrando ? 'Mostrar contraseña' : 'Ocultar contraseña');
    iconoVisible.toggleAttribute('hidden', !mostrando);
    iconoOculto.toggleAttribute('hidden', mostrando);
  });
});
