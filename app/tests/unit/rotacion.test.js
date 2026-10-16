const crypto = require('crypto');
const { cifrarCon, descifrarCon, hmacCon, cifrar, descifrar } = require('../../src/lib/cifrado');

describe('cifrado con una llave explícita (rotación)', () => {
  const llave = crypto.randomBytes(32);
  const otra = crypto.randomBytes(32);

  it('cifrarCon y descifrarCon son inversas con la misma llave y el mismo campo', () => {
    expect(descifrarCon(llave, 'paciente.nombre', cifrarCon(llave, 'paciente.nombre', 'Ana'))).toBe('Ana');
  });

  it('descifrarCon rechaza otra llave u otro campo', () => {
    const blob = cifrarCon(llave, 'paciente.nombre', 'Ana');
    expect(() => descifrarCon(otra, 'paciente.nombre', blob)).toThrow();
    expect(() => descifrarCon(llave, 'paciente.rut', blob)).toThrow();
  });

  it('cifrar y descifrar siguen usando la llave del entorno', () => {
    const llaveEntorno = Buffer.from(process.env.PACIENTE_IDENTIDAD_KEY, 'base64');
    expect(descifrarCon(llaveEntorno, 'paciente.nombre', cifrar('paciente.nombre', 'Luis'))).toBe('Luis');
    expect(descifrar('paciente.nombre', cifrarCon(llaveEntorno, 'paciente.nombre', 'Luis'))).toBe('Luis');
  });

  it('hmacCon depende de la llave', () => {
    expect(hmacCon(llave, 'x').equals(hmacCon(llave, 'x'))).toBe(true);
    expect(hmacCon(llave, 'x').equals(hmacCon(otra, 'x'))).toBe(false);
  });
});
