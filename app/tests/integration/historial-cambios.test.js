const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, rutAleatorio } = require('../helpers/datos');
const { descifrar } = require('../../src/lib/cifrado');
const { ultimoCambioDe } = require('../../src/services/pacienteService');

// Rectificación (Hito 3): toda edición del paciente deja, por cada campo que
// cambió, qué valor había (cifrado con la llave de su categoría), quién y
// cuándo. El valor nuevo ya está en el paciente: no se duplica.
describe('Historial de cambios del paciente', () => {
  const password = 'Password123!';
  let agent;
  let paciente;
  const original = { nombre: 'Rosa Historial', fechaNacimiento: '1980-02-03', contacto: '+56944445555' };

  beforeAll(async () => {
    const operador = await usuarioDePrueba('historial-operador@medibox.local', 'operador', password);
    ({ agent } = await loginAgent(app, { email: operador.email, password }));
    const res = await agent.post('/api/pacientes').send({ ...original, rut: rutAleatorio() });
    expect(res.status).toBe(201);
    paciente = await prisma.paciente.findUniqueOrThrow({ where: { id: res.body.id } });
    paciente.rut = descifrar('paciente.rut', paciente.rutCifrado);
  });

  afterAll(async () => {
    await prisma.historialCambio.deleteMany({ where: { pacienteId: paciente.id } });
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.$disconnect();
  });

  it('editar nombre y contacto deja dos filas con el valor anterior cifrado, nunca en claro', async () => {
    const res = await agent.patch(`/api/pacientes/${paciente.id}`).send({ ...original, rut: paciente.rut, nombre: 'Rosa Rectificada', contacto: '+56966667777' });
    expect(res.status).toBe(200);

    const filas = await prisma.historialCambio.findMany({ where: { pacienteId: paciente.id }, orderBy: { campo: 'asc' } });
    expect(filas.map((f) => f.campo)).toEqual(['contacto', 'nombre']);

    const crudas = await prisma.$queryRaw`SELECT valor_anterior_cifrado FROM historial_cambios WHERE paciente_id = ${paciente.id}`;
    crudas.forEach((c) => {
      const texto = Buffer.from(c.valor_anterior_cifrado).toString('latin1');
      expect(texto).not.toContain('Rosa Historial');
      expect(texto).not.toContain('44445555');
    });

    const nombre = filas.find((f) => f.campo === 'nombre');
    expect(descifrar('historial.nombre', nombre.valorAnteriorCifrado)).toBe('Rosa Historial');
    expect(descifrar('historial.contacto', filas.find((f) => f.campo === 'contacto').valorAnteriorCifrado)).toBe('+56944445555');
  });

  it('editar sin cambios no deja filas nuevas', async () => {
    const antes = await prisma.historialCambio.count({ where: { pacienteId: paciente.id } });
    const res = await agent.patch(`/api/pacientes/${paciente.id}`).send({ ...original, rut: paciente.rut, nombre: 'Rosa Rectificada', contacto: '+56966667777' });
    expect(res.status).toBe(200);
    expect(await prisma.historialCambio.count({ where: { pacienteId: paciente.id } })).toBe(antes);
  });

  it('ultimoCambioDe devuelve la fecha del último cambio de un campo', async () => {
    const fecha = await ultimoCambioDe(paciente.id, 'contacto');
    expect(fecha).toBeInstanceOf(Date);
    expect(Date.now() - fecha.getTime()).toBeLessThan(60 * 1000);
    expect(await ultimoCambioDe(paciente.id, 'rut')).toBeNull();
  });

  it('la ficha muestra el historial sin los valores anteriores', async () => {
    const res = await agent.get(`/pacientes/${paciente.id}`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Historial de cambios');
    expect(res.text).not.toContain('Rosa Historial');
    expect(res.text).not.toContain('44445555');
  });
});
