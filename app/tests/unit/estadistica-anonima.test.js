const { agregarAnonimo } = require('../../src/services/pacienteService');

function citas(pacienteIds, grupo) {
  return pacienteIds.map((pacienteId) => ({ pacienteId, ...grupo }));
}

describe('agregación anónima con umbral k', () => {
  const cardiologia2026 = { anio: 2026, especialidad: 'Cardiología', tramoEtario: '30-39' };

  it('publica un grupo con al menos k pacientes distintos, sin ids', () => {
    const { filas, suprimidos } = agregarAnonimo(citas([1, 2, 3, 4, 5, 5], cardiologia2026), 5);

    expect(filas).toEqual([{ ...cardiologia2026, pacientes: 5, citas: 6 }]);
    expect(suprimidos).toBe(0);
    expect(JSON.stringify(filas)).not.toMatch(/pacienteId/);
  });

  it('suprime el grupo que singulariza a menos de k personas, aunque tenga muchas citas', () => {
    const pediatria = { anio: 2026, especialidad: 'Pediatría', tramoEtario: '0-9' };
    const { filas, suprimidos } = agregarAnonimo([...citas([1, 2, 3, 4, 5], cardiologia2026), ...citas([9, 9, 9, 9, 9, 9], pediatria)], 5);

    expect(filas.map((f) => f.especialidad)).toEqual(['Cardiología']);
    expect(suprimidos).toBe(1);
  });

  it('ordena por año, especialidad y tramo etario', () => {
    const ids = [1, 2, 3, 4, 5];
    const { filas } = agregarAnonimo([
      ...citas(ids, { anio: 2026, especialidad: 'Neurología', tramoEtario: '10-19' }),
      ...citas(ids, { anio: 2026, especialidad: 'Cardiología', tramoEtario: '80+' }),
      ...citas(ids, { anio: 2026, especialidad: 'Cardiología', tramoEtario: '10-19' }),
      ...citas(ids, { anio: 2025, especialidad: 'Neurología', tramoEtario: '10-19' }),
    ]);

    expect(filas.map((f) => `${f.anio} ${f.especialidad} ${f.tramoEtario}`)).toEqual([
      '2025 Neurología 10-19',
      '2026 Cardiología 10-19',
      '2026 Cardiología 80+',
      '2026 Neurología 10-19',
    ]);
  });
});
