const request = require('supertest');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');

// Política de tratamiento (Ley 21.719, art. 14 ter): pública, sin sesión.
describe('Política de tratamiento /privacidad', () => {
  afterAll(() => prisma.$disconnect());

  it('se ve sin iniciar sesión y explica finalidades, derechos y cómo ejercerlos', async () => {
    const res = await request(app).get('/privacidad').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    for (const texto of ['Recordatorios de citas', 'Investigación y estadística', 'Encuestas de satisfacción', 'Rectificación', 'Portabilidad', 'Por teléfono o por correo', 'Ley 20.584']) {
      expect(res.text).toContain(texto);
    }
  });

  it('el login enlaza a la política', async () => {
    const res = await request(app).get('/auth/login-form');
    expect(res.text).toContain('href="/privacidad"');
  });
});
