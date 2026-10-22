const request = require('supertest');
const app = require('../../src/app');

describe('GET /health', () => {
  it('returns 200 and ok:true', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /', () => {
  it('sin sesión del portal, ofrece el ingreso con RUT y su token CSRF', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('action="/portal/ingresar"');
    // El token del formulario es el de la sesión que se acaba de abrir.
    expect(res.text).toContain(`name="_csrf" value="${res.headers['x-csrf-token']}"`);
  });
});

describe('GET /privacidad', () => {
  it('separa la cita legal del texto y deja los paréntesis que no son leyes', async () => {
    const res = await request(app).get('/privacidad');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Al menos 15 años.<span class="doc-cita">Ley 20.584, art. 13</span>');
    expect(res.text).toContain('Órgano público (avisos); consentimiento (recordatorios y encuestas).');
  });
});
