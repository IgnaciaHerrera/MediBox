document.querySelectorAll('[data-topbar]').forEach((topbar) => {
  const abrir = topbar.querySelector('[data-topbar-abrir]');
  const velo = topbar.querySelector('.topbar-velo');
  const panel = topbar.querySelector('.topbar-nav');

  function fijar(abierto) {
    topbar.classList.toggle('abierto', abierto);
    abrir.setAttribute('aria-expanded', String(abierto));
    velo.toggleAttribute('hidden', !abierto);
    document.body.classList.toggle('sin-scroll', abierto);
    if (abierto) {
      panel.querySelector('[data-topbar-cerrar]').focus();
    } else {
      abrir.focus();
    }
  }

  abrir.addEventListener('click', () => fijar(true));
  topbar.querySelectorAll('[data-topbar-cerrar]').forEach((el) => {
    el.addEventListener('click', () => fijar(false));
  });

  document.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape' && topbar.classList.contains('abierto')) fijar(false);
  });
});
