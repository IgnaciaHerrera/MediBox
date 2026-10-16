const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { descifrar } = require('../../src/lib/cifrado');

// La búsqueda de pacientes (un nombre o un RUT) no viaja en la URL: quedaba
// en el historial del navegador (riesgo residual del Hito 2). Va en el
// cuerpo de un POST y no se guarda en ninguna parte.
describe('Búsqueda de pacientes por POST', () => {
  const password = 'Password123!';
  let agente;
  let paciente;

  beforeAll(async () => {
    const operador = await usuarioDePrueba('busqueda-operador@medibox.local', 'operador', password);
    ({ agent: agente } = await loginAgent(app, { email: operador.email, password }));
    paciente = await pacienteDePrueba({ nombre: 'Búsqueda Única Xyzzy' });
  });

  afterAll(async () => {
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.$disconnect();
  });

  it('POST /pacientes/buscar muestra la coincidencia sin dejar el término en la URL', async () => {
    const res = await agente.post('/pacientes/buscar').set('Accept', 'text/html').type('form').send({ q: 'unica xyzzy' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Búsqueda Única Xyzzy');
    expect(res.text).not.toMatch(/href="[^"]*[?&]q=/);
  });

  it('POST /api/pacientes/buscar encuentra por nombre y por RUT', async () => {
    const porNombre = await agente.post('/api/pacientes/buscar').send({ q: 'Xyzzy' });
    expect(porNombre.status).toBe(200);
    expect(porNombre.body.items.map((p) => p.id)).toEqual([paciente.id]);

    const porRut = await agente.post('/api/pacientes/buscar').send({ q: descifrar('paciente.rut', paciente.rutCifrado) });
    expect(porRut.body.items.map((p) => p.id)).toEqual([paciente.id]);
  });

  it('GET con ?q= ya no filtra: el término en la URL se ignora', async () => {
    const res = await agente.get('/api/pacientes?q=zzzz-no-existe&pageSize=200');
    expect(res.body.items.map((p) => p.id)).toContain(paciente.id);
    const vista = await agente.get('/pacientes?q=zzzz-no-existe').set('Accept', 'text/html');
    expect(vista.text).not.toContain('No se encontraron pacientes');
  });
});
