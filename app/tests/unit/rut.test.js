const { normalizarRut, rutValido } = require('../../src/lib/rut');

describe('rut', () => {
  it('normalizes dots, spaces, leading zeros and lowercase k to one canonical form', () => {
    expect(normalizarRut('12.345.678-5')).toBe('12345678-5');
    expect(normalizarRut(' 012345678-5 ')).toBe('12345678-5');
    expect(normalizarRut('12.345.678-k')).toBe('12345678-K');
    expect(normalizarRut('123456785')).toBe('12345678-5');
  });

  it('accepts RUTs whose check digit matches, including 0 and K', () => {
    expect(rutValido('12.345.678-5')).toBe(true);
    expect(rutValido('11111111-1')).toBe(true);
    expect(rutValido('12345678-5')).toBe(true);
    expect(rutValido('10000013-K')).toBe(true);
    expect(rutValido('10000004-0')).toBe(true);
  });

  it('rejects a wrong check digit, non-numeric bodies and empty input', () => {
    expect(rutValido('12345678-9')).toBe(false);
    expect(rutValido('1234a678-5')).toBe(false);
    expect(rutValido('123456789-2')).toBe(false);
    expect(rutValido('0-0')).toBe(false);
    expect(rutValido('')).toBe(false);
  });
});
