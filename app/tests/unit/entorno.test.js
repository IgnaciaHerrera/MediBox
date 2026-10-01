const crypto = require('crypto');
const { revisarEntorno } = require('../../src/lib/entorno');
const { VARIABLES_DE_LLAVE } = require('../../src/lib/cifrado');

describe('revisarEntorno', () => {
  const entornoOriginal = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://medibox:una-clave-real@db:5432/medibox';
    process.env.SESSION_SECRET = crypto.randomBytes(48).toString('base64');
    VARIABLES_DE_LLAVE.forEach((variable) => {
      process.env[variable] = crypto.randomBytes(32).toString('base64');
    });
  });

  afterAll(() => {
    process.env = entornoOriginal;
  });

  it('accepts a complete configuration', () => {
    expect(revisarEntorno()).toEqual([]);
  });

  it('rejects the example values from .env.example', () => {
    process.env.SESSION_SECRET = 'change-me-too';
    process.env.DATABASE_URL = 'postgresql://medibox:change-me@db:5432/medibox';
    process.env.PACIENTE_CLINICO_KEY = 'change-me-as-well';

    const problemas = revisarEntorno();
    expect(problemas).toHaveLength(3);
    expect(problemas.join('\n')).toMatch(/SESSION_SECRET/);
    expect(problemas.join('\n')).toMatch(/DATABASE_URL usa la contraseña de ejemplo/);
    expect(problemas.join('\n')).toMatch(/PACIENTE_CLINICO_KEY/);
  });

  it('only flags the example database password in production', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://medibox:change-me@db:5432/medibox';
    expect(revisarEntorno()).toEqual([]);
  });

  it('never includes a secret value in its messages', () => {
    process.env.SESSION_SECRET = 'corto-pero-secreto';
    delete process.env.PACIENTE_RUT_HMAC_KEY;
    const mensajes = revisarEntorno().join('\n');
    expect(mensajes).toMatch(/SESSION_SECRET/);
    expect(mensajes).toMatch(/PACIENTE_RUT_HMAC_KEY/);
    expect(mensajes).not.toContain('corto-pero-secreto');
  });
});
