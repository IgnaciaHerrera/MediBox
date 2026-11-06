const { sugerirSeveridad } = require('../../src/services/incidenteService');

// Criterio de gravedad del plan de respuesta: lo que se sabe del incidente
// sugiere una severidad; la decide quien coordina.
describe('sugerirSeveridad', () => {
  const base = {
    categoriasDatos: [],
    titularesAfectados: null,
    incluyeMenores: false,
    dimension: 'confidencialidad',
  };

  it.each([
    [{ categoriasDatos: ['credenciales'] }, 'critica'],
    [{ categoriasDatos: ['salud'], titularesAfectados: 100 }, 'critica'],
    [{ categoriasDatos: ['identidad'], incluyeMenores: true, titularesAfectados: 250 }, 'critica'],
    [{ categoriasDatos: ['salud'], titularesAfectados: 3 }, 'alta'],
    [{ categoriasDatos: ['menores'], titularesAfectados: 1 }, 'alta'],
    [{ categoriasDatos: ['contacto'], titularesAfectados: 100 }, 'alta'],
    [{ categoriasDatos: ['identidad', 'contacto'], titularesAfectados: 12 }, 'media'],
    [{ dimension: 'disponibilidad' }, 'media'],
    [{}, 'baja'],
  ])('%o -> %s', (datos, esperada) => {
    expect(sugerirSeveridad({ ...base, ...datos }).severidad).toBe(esperada);
  });

  it('credenciales filtradas son críticas solo si se comprometió la confidencialidad', () => {
    expect(
      sugerirSeveridad({ ...base, categoriasDatos: ['credenciales'], dimension: 'integridad' })
        .severidad,
    ).toBe('media');
  });
});
