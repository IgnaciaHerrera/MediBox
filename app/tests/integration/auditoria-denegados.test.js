const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');

// Un acceso negado a un paciente también es una señal (alguien buscando
// datos que no le corresponden): queda en la auditoría como 'denegado', sin
// cambiar lo que ve el usuario (403, o 404 si está fuera de su alcance).
describe('Auditoría de accesos denegados a pacientes', () => {
  const password = 'Password123!';
  let gestor;
  let medicoUsuario;
  let paciente;
  let inicio;

  function filaDenegada(usuarioId, entidadId) {
    return prisma.auditLog.findFirst({
      where: { usuarioId, accion: 'READ', entidad: 'Paciente', entidadId, resultado: 'denegado', timestamp: { gte: inicio } },
    });
  }

  beforeAll(async () => {
    gestor = await usuarioDePrueba('denegados-gestor@medibox.local', 'gestor', password);
    medicoUsuario = await usuarioDePrueba('denegados-medico@medibox.local', 'medico', password);
    paciente = await pacienteDePrueba({ nombre: 'Paciente Denegados' });
    inicio = new Date();
  });

  afterAll(async () => {
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.$disconnect();
  });

  it('un gestor en /api/pacientes/:id recibe 403 y queda una fila denegado', async () => {
    const { agent } = await loginAgent(app, { email: gestor.email, password });
    expect((await agent.get(`/api/pacientes/${paciente.id}`)).status).toBe(403);
    expect(await filaDenegada(gestor.id, paciente.id)).not.toBeNull();
  });

  it('un médico que pide una ficha ajena recibe 404 y queda una fila denegado con el id', async () => {
    const { agent } = await loginAgent(app, { email: medicoUsuario.email, password });
    expect((await agent.get(`/api/pacientes/${paciente.id}`)).status).toBe(404);
    expect(await filaDenegada(medicoUsuario.id, paciente.id)).not.toBeNull();
  });

  it('un id inexistente responde 404 sin fila denegado', async () => {
    const { agent } = await loginAgent(app, { email: medicoUsuario.email, password });
    const inexistente = 2000000000;
    expect((await agent.get(`/api/pacientes/${inexistente}`)).status).toBe(404);
    expect(await filaDenegada(medicoUsuario.id, inexistente)).toBeNull();
  });
});
