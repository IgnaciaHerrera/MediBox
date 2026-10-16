const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { limpiarPacientes } = require('../helpers/derechos');
const canalEnvio = require('../../src/lib/canalEnvio');
const { seudonimo } = require('../../src/services/pacienteService');
const { enviarRecordatorios } = require('../../src/services/recordatorioService');

// Un paciente bloqueado (por un bloqueo o una supresión) se conserva, pero no
// se usa para nada: ni por la vista, ni por la API, ni por id directo, ni en
// reportes o procesos. Solo privacidad lo lee, a través de una solicitud.
describe('Efectos del bloqueo de un paciente', () => {
  const password = 'Password123!';
  const FECHA = '2099-08-01';
  let operador;
  let agenteOperador;
  let bloqueado;
  let libre;
  let cita;

  beforeAll(async () => {
    operador = await usuarioDePrueba('bloqueo-operador@medibox.local', 'operador', password);
    ({ agent: agenteOperador } = await loginAgent(app, { email: operador.email, password }));
    bloqueado = await pacienteDePrueba({ nombre: 'Paciente Bloqueado Prueba', contacto: '+56976000001' });
    libre = await pacienteDePrueba({ nombre: 'Paciente Libre Prueba' });

    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    cita = await prisma.cita.create({ data: { pacienteId: bloqueado.id, medicoId: medico.id, boxId: box.id, fecha: new Date(FECHA), horaInicio: '00:10', horaFin: '00:20' } });

    // Consentimientos vigentes de recordatorios e investigación, directo en la
    // base: el bloqueo debe sacarlo igual de esos procesos.
    const verificacion = await prisma.verificacionIdentidad.create({ data: { pacienteId: bloqueado.id, metodo: 'cedula_presencial', verificadaPorId: operador.id, verificadaEl: new Date() } });
    for (const clave of ['recordatorios', 'investigacion']) {
      const finalidad = await prisma.finalidad.findUniqueOrThrow({ where: { clave }, include: { textos: { orderBy: { version: 'desc' }, take: 1 } } });
      await prisma.consentimiento.create({
        data: { pacienteId: bloqueado.id, finalidadId: finalidad.id, textoId: finalidad.textos[0].id, canal: 'presencial', otorgadoPor: 'titular', registradoPorId: operador.id, verificacionId: verificacion.id },
      });
    }
    await prisma.paciente.update({ where: { id: bloqueado.id }, data: { bloqueado: true, bloqueadoEl: new Date() } });
  });

  afterAll(async () => {
    await limpiarPacientes([bloqueado.id, libre.id]);
    await prisma.$disconnect();
  });

  it('no aparece en el listado de pacientes ni en el selector para agendar', async () => {
    const lista = await agenteOperador.get('/api/pacientes?pageSize=200');
    expect(lista.body.items.map((p) => p.id)).not.toContain(bloqueado.id);
    expect(lista.body.items.map((p) => p.id)).toContain(libre.id);
    const formulario = await agenteOperador.get('/agenda/nueva').set('Accept', 'text/html');
    expect(formulario.text).not.toContain('Paciente Bloqueado Prueba');
  });

  it('su ficha responde 404 por id directo, en la API y en la vista', async () => {
    expect((await agenteOperador.get(`/api/pacientes/${bloqueado.id}`)).status).toBe(404);
    expect((await agenteOperador.get(`/pacientes/${bloqueado.id}`).set('Accept', 'text/html')).status).toBe(404);
  });

  it('no se le puede agendar una cita, ni siquiera por la API', async () => {
    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    const res = await agenteOperador.post('/api/citas').send({ pacienteId: bloqueado.id, medicoId: medico.id, boxId: box.id, fecha: '2099-08-02', horaInicio: '00:30', horaFin: '00:40', motivoConsulta: 'Control' });
    expect(res.status).toBe(400);
  });

  it('sale de los reportes de gestión e investigación', async () => {
    const gestor = await usuarioDePrueba('bloqueo-gestor@medibox.local', 'gestor', password);
    const { agent } = await loginAgent(app, { email: gestor.email, password });
    for (const reporte of ['pacientes', 'investigacion', 'citas']) {
      const res = await agent.get(`/datos/exportar/${reporte}.csv`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(seudonimo(bloqueado.id));
    }
  });

  it('no recibe recordatorios aunque tenga el consentimiento', async () => {
    await enviarRecordatorios({ fecha: FECHA });
    expect(canalEnvio.ultimo('+56976000001')).toBeUndefined();
  });

  it('el detalle de una de sus citas indica que los datos están restringidos', async () => {
    const res = await agenteOperador.get(`/agenda/${cita.id}`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Datos del paciente restringidos');
    expect(res.text).not.toContain('Paciente Bloqueado Prueba');
  });
});
