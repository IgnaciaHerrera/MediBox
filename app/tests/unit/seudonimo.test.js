const { seudonimo, tramoEtario } = require('../../src/services/pacienteService');

describe('seudonimización de pacientes en las exportaciones', () => {
  it('da siempre el mismo seudónimo al mismo paciente y uno distinto a otro', () => {
    expect(seudonimo(42)).toMatch(/^P-[0-9A-F]{16}$/);
    expect(seudonimo(42)).toBe(seudonimo(42));
    expect(seudonimo(42)).not.toBe(seudonimo(43));
    // No deja ver el id: no es una codificación reversible sin la llave.
    expect(seudonimo(42)).not.toContain('42');
  });

  it('cambia por completo con otra llave', () => {
    const original = process.env.PACIENTE_SEUDONIMO_KEY;
    const conLlaveActual = seudonimo(7);
    process.env.PACIENTE_SEUDONIMO_KEY = Buffer.alloc(32, 9).toString('base64');
    try {
      expect(seudonimo(7)).not.toBe(conLlaveActual);
    } finally {
      process.env.PACIENTE_SEUDONIMO_KEY = original;
    }
  });

  it('generaliza la edad a tramos de diez años, con el último abierto', () => {
    expect(tramoEtario(0)).toBe('0-9');
    expect(tramoEtario(9)).toBe('0-9');
    expect(tramoEtario(10)).toBe('10-19');
    expect(tramoEtario(79)).toBe('70-79');
    expect(tramoEtario(80)).toBe('80+');
    expect(tramoEtario(103)).toBe('80+');
  });
});
