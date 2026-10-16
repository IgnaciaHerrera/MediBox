const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const consentimiento = require('../../src/services/consentimientoService');

const ROLES_PREDETERMINADOS = ['consulta', 'operador', 'medico', 'gestor', 'admin'];

// Los consentimientos se gestionan desde la ficha del paciente: el operador
// verifica la identidad, muestra el texto vigente y registra el otorgamiento
// o la revocación con el canal por el que llegó la petición. El médico no
// los ve (no los necesita para atender).
describe('Consentimientos en la ficha del paciente', () => {
  const password = 'Password123!';
  let operador;
  let medicoUsuario;
  let medico;
  let paciente;
  let cita;
  let agente;

  async function textoVigente(clave) {
    const estado = await consentimiento.estadoPorPaciente(paciente.id);
    return estado.find((e) => e.finalidad.clave === clave).textoVigente;
  }

  beforeAll(async () => {
    operador = await usuarioDePrueba('consentimiento-vista-operador@medibox.local', 'operador', password);
    medicoUsuario = await usuarioDePrueba('consentimiento-vista-medico@medibox.local', 'medico', password);
    paciente = await pacienteDePrueba({ nombre: 'Paciente Ficha Consentimiento' });

    const especialidad = await prisma.especialidad.findFirstOrThrow();
    medico = await prisma.medico.upsert({
      where: { usuarioId: medicoUsuario.id },
      update: {},
      create: { nombre: 'Dr. Ficha Consentimiento', especialidadId: especialidad.id, usuarioId: medicoUsuario.id },
    });
    const box = await prisma.box.findFirstOrThrow();
    cita = await prisma.cita.create({
      data: { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: new Date('2099-04-01'), horaInicio: '05:00', horaFin: '05:15' },
    });

    ({ agent: agente } = await loginAgent(app, { email: operador.email, password }));
    expect((await agente.post(`/verificacion/${paciente.id}/cedula`).send({ cedulaVista: 'si' })).status).toBe(200);
  });

  afterAll(async () => {
    await prisma.cita.delete({ where: { id: cita.id } });
    await prisma.consentimiento.deleteMany({ where: { pacienteId: paciente.id } });
    await prisma.verificacionIdentidad.deleteMany({ where: { pacienteId: paciente.id } });
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.$disconnect();
  });

  it('la ficha del operador muestra los consentimientos con el texto vigente', async () => {
    const res = await agente.get(`/pacientes/${paciente.id}`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Consentimientos');
    expect(res.text).toContain((await textoVigente('recordatorios')).texto.slice(0, 40));
    expect(res.text).toContain('Verificar con cédula');
  });

  it('otorgar sin marcar la casilla de aceptación responde 400 y no registra nada', async () => {
    const texto = await textoVigente('recordatorios');
    const res = await agente.post(`/pacientes/${paciente.id}/consentimientos/recordatorios/otorgar`).send({ textoId: texto.id, canal: 'presencial' });
    expect(res.status).toBe(400);
    expect(await prisma.consentimiento.count({ where: { pacienteId: paciente.id } })).toBe(0);
  });

  it('otorgar y revocar desde la ficha cambian el estado', async () => {
    const texto = await textoVigente('recordatorios');
    const otorgar = await agente.post(`/pacientes/${paciente.id}/consentimientos/recordatorios/otorgar`).send({ textoId: texto.id, canal: 'telefono', acepta: 'si' });
    expect(otorgar.status).toBe(200);
    expect(await consentimiento.tieneVigente(paciente.id, 'recordatorios')).toBe(true);

    const revocar = await agente.post(`/pacientes/${paciente.id}/consentimientos/recordatorios/revocar`).send({ canal: 'correo' });
    expect(revocar.status).toBe(200);
    expect(await consentimiento.tieneVigente(paciente.id, 'recordatorios')).toBe(false);
  });

  it('el médico no ve la sección ni puede usar las rutas', async () => {
    const { agent } = await loginAgent(app, { email: medicoUsuario.email, password });
    const ficha = await agent.get(`/pacientes/${paciente.id}`).set('Accept', 'text/html');
    expect(ficha.status).toBe(200);
    expect(ficha.text).not.toContain('Consentimientos');

    const texto = await textoVigente('encuestas');
    expect((await agent.post(`/pacientes/${paciente.id}/consentimientos/encuestas/otorgar`).send({ textoId: texto.id, canal: 'presencial', acepta: 'si' })).status).toBe(403);
  });

  it('entre los roles predeterminados, solo el operador tiene consentimiento.write', async () => {
    const roles = await prisma.rol.findMany({
      where: { nombre: { in: ROLES_PREDETERMINADOS }, permisos: { some: { permiso: { clave: 'consentimiento.write' } } } },
      select: { nombre: true },
    });
    expect(roles.map((r) => r.nombre)).toEqual(['operador']);
  });
});
