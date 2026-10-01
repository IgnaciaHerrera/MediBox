const crypto = require('crypto');
const { cifrar, descifrar, indiceCiego, revisarLlaves, VARIABLES_DE_LLAVE } = require('../../src/lib/cifrado');

const llaveAleatoria = () => crypto.randomBytes(32).toString('base64');

describe('cifrado', () => {
  const entornoOriginal = { ...process.env };

  beforeEach(() => {
    VARIABLES_DE_LLAVE.forEach((variable) => {
      process.env[variable] = llaveAleatoria();
    });
  });

  afterAll(() => {
    process.env = entornoOriginal;
  });

  it('round-trips a value and never stores the plaintext inside the blob', () => {
    const blob = cifrar('paciente.motivoConsulta', 'Control cardiológico');
    expect(blob.toString('utf8')).not.toContain('Control cardiológico');
    expect(descifrar('paciente.motivoConsulta', blob)).toBe('Control cardiológico');
  });

  it('produces a different blob each time for the same value (random IV)', () => {
    const a = cifrar('paciente.rut', '12345678-5');
    const b = cifrar('paciente.rut', '12345678-5');
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a blob that was tampered with', () => {
    const blob = cifrar('paciente.contacto', '+56911112222');
    blob[blob.length - 1] ^= 0x01;
    expect(() => descifrar('paciente.contacto', blob)).toThrow();
  });

  it('rejects a blob moved to another field even when both share the key', () => {
    const blob = cifrar('paciente.rut', '12345678-5');
    expect(() => descifrar('paciente.nombre', blob)).toThrow();
  });

  it('cannot decrypt after the key is replaced', () => {
    const blob = cifrar('paciente.motivoConsulta', 'Dolor lumbar');
    process.env.PACIENTE_CLINICO_KEY = llaveAleatoria();
    expect(() => descifrar('paciente.motivoConsulta', blob)).toThrow();
  });

  it('fails without revealing the value when a key is missing or malformed', () => {
    process.env.PACIENTE_CONTACTO_KEY = 'change-me-as-well';
    expect(() => cifrar('paciente.contacto', 'x')).toThrow(/PACIENTE_CONTACTO_KEY debe ser una llave de 32 bytes/);
    expect(() => cifrar('paciente.contacto', 'x')).not.toThrow(/change-me/);

    delete process.env.PACIENTE_CONTACTO_KEY;
    expect(() => cifrar('paciente.contacto', 'x')).toThrow(/PACIENTE_CONTACTO_KEY/);
  });

  it('computes a deterministic blind index that depends on its own key', () => {
    const indice = indiceCiego('paciente.rut', '12345678-5');
    expect(indice).toHaveLength(32);
    expect(indiceCiego('paciente.rut', '12345678-5').equals(indice)).toBe(true);

    process.env.PACIENTE_RUT_HMAC_KEY = llaveAleatoria();
    expect(indiceCiego('paciente.rut', '12345678-5').equals(indice)).toBe(false);
  });

  it('reports missing and reused keys', () => {
    expect(revisarLlaves()).toEqual([]);

    process.env.PACIENTE_CLINICO_KEY = process.env.PACIENTE_IDENTIDAD_KEY;
    delete process.env.PACIENTE_RUT_HMAC_KEY;
    const problemas = revisarLlaves();
    expect(problemas).toHaveLength(2);
    expect(problemas.join('\n')).toMatch(/repite la llave/);
    expect(problemas.join('\n')).toMatch(/PACIENTE_RUT_HMAC_KEY/);
  });
});
