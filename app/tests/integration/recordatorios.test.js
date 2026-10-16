const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const canalEnvio = require('../../src/lib/canalEnvio');
const consentimiento = require('../../src/services/consentimientoService');
const verificacion = require('../../src/services/verificacionService');
const { enviarRecordatorios } = require('../../src/services/recordatorioService');
const { seudonimo } = require('../../src/services/pacienteService');

// La revocación detiene de verdad el tratamiento: los procesos de una
// finalidad consultan el consentimiento vigente justo antes de tratar el dato.
describe('La revocación detiene el tratamiento', () => {
  const password = 'Password123!';
  const FECHA = '2099-05-10';
  let operador;
  let solicitante;
  const pacientes = {};
  const citas = [];

  async function otorgar(paciente, clave) {
    await verificacion.verificarConCedula(paciente.id, solicitante);
    const [estado] = (await consentimiento.estadoPorPaciente(paciente.id)).filter((e) => e.finalidad.clave === clave);
    await consentimiento.otorgar({ pacienteId: paciente.id, finalidadClave: clave, textoId: estado.textoVigente.id, canal: 'presencial' }, solicitante);
  }

  async function revocar(paciente, clave) {
    await verificacion.verificarConCedula(paciente.id, solicitante);
    await consentimiento.revocar({ pacienteId: paciente.id, finalidadClave: clave, canal: 'telefono' }, solicitante);
  }

  async function citaEl(paciente, horaInicio) {
    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    const cita = await prisma.cita.create({
      data: { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: new Date(FECHA), horaInicio, horaFin: `${horaInicio.slice(0, 3)}50` },
    });
    citas.push(cita.id);
  }

  beforeAll(async () => {
    operador = await usuarioDePrueba('recordatorios-operador@medibox.local', 'operador', password);
    solicitante = { id: operador.id, permisos: ['paciente.read', 'consentimiento.write'] };
    pacientes.conConsentimiento = await pacienteDePrueba({ nombre: 'Rec Con', contacto: '+56972000001' });
    pacientes.sinContacto = await pacienteDePrueba({ nombre: 'Rec Sin Contacto' });
    pacientes.sinConsentimiento = await pacienteDePrueba({ nombre: 'Rec Sin Consentimiento', contacto: '+56972000003' });
    await citaEl(pacientes.conConsentimiento, '04:00');
    await citaEl(pacientes.sinContacto, '04:00');
    await citaEl(pacientes.sinConsentimiento, '03:00');
    await otorgar(pacientes.conConsentimiento, 'recordatorios');
    await otorgar(pacientes.sinContacto, 'recordatorios');
  });

  afterAll(async () => {
    const ids = Object.values(pacientes).map((p) => p.id);
    await prisma.cita.deleteMany({ where: { id: { in: citas } } });
    await prisma.consentimiento.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.verificacionIdentidad.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.paciente.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('con el consentimiento vigente recibe el recordatorio, sin médico ni motivo; tras revocarlo, no', async () => {
    const primera = await enviarRecordatorios({ fecha: FECHA });
    const mensaje = canalEnvio.ultimo('+56972000001');
    expect(mensaje.mensaje).toBe('Recordatorio de MediBox: tiene una cita el 10-05-2099 a las 04:00.');
    expect(primera.enviados).toBe(1);

    await revocar(pacientes.conConsentimiento, 'recordatorios');
    const segunda = await enviarRecordatorios({ fecha: FECHA });
    expect(segunda.enviados).toBe(0);
    expect(canalEnvio.ultimo('+56972000001').enviadoEl).toEqual(mensaje.enviadoEl);
  });

  it('sin contacto o sin consentimiento no recibe nada', async () => {
    await enviarRecordatorios({ fecha: FECHA });
    expect(canalEnvio.ultimo('+56972000003')).toBeUndefined();
  });

  it('cada corrida queda en la auditoría como acción del sistema, con el conteo', async () => {
    const antes = new Date();
    const resumen = await enviarRecordatorios({ fecha: FECHA });
    const fila = await prisma.auditLog.findFirst({ where: { accion: 'RECORDATORIO', timestamp: { gte: antes } }, orderBy: { id: 'desc' } });
    expect(fila).toMatchObject({ actor: 'sistema', usuarioId: null, detalle: resumen });
  });

  it('el reporte de investigación solo incluye a quien tiene ese consentimiento vigente', async () => {
    await otorgar(pacientes.sinConsentimiento, 'investigacion');
    await otorgar(pacientes.conConsentimiento, 'investigacion');
    await revocar(pacientes.conConsentimiento, 'investigacion');

    const gestor = await usuarioDePrueba('recordatorios-gestor@medibox.local', 'gestor', password);
    const { agent } = await loginAgent(app, { email: gestor.email, password });
    const res = await agent.get('/datos/exportar/investigacion.csv');
    expect(res.status).toBe(200);
    expect(res.text).toContain(seudonimo(pacientes.sinConsentimiento.id));
    expect(res.text).not.toContain(seudonimo(pacientes.conConsentimiento.id));
    expect(res.text).not.toContain(seudonimo(pacientes.sinContacto.id));
  });
});
