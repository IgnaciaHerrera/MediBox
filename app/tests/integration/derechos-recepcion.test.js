const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const canalEnvio = require('../../src/lib/canalEnvio');
const verificacion = require('../../src/services/verificacionService');

const DIA = 24 * 60 * 60 * 1000;
const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// Recepción de solicitudes de derechos (Hito 3): llegan por cualquier canal
// y las registra un funcionario. Registrar no exige verificar la identidad;
// actuar sí, y con el método que acepta cada derecho (supresión y bloqueo,
// solo con cédula). Una solicitud sin verificar queda pendiente, no se rechaza.
describe('Recepción y verificación de solicitudes de derechos', () => {
  const password = 'Password123!';
  let operador;
  let agente;
  const pacientes = {};

  const solicitante = () => ({ id: operador.id, permisos: ['paciente.read', 'derechos.registrar'] });

  async function registrar(paciente, cuerpo) {
    return agente.post(`/pacientes/${paciente.id}/solicitudes`).send(cuerpo);
  }

  async function verificarPorCodigo(paciente, contacto) {
    await verificacion.enviarCodigo(paciente.id, solicitante());
    const codigo = canalEnvio.ultimo(contacto).mensaje.match(/\b(\d{6})\b/)[1];
    await verificacion.confirmarCodigo(paciente.id, codigo, solicitante());
  }

  beforeAll(async () => {
    operador = await usuarioDePrueba('derechos-recepcion-operador@medibox.local', 'operador', password);
    ({ agent: agente } = await loginAgent(app, { email: operador.email, password }));
    pacientes.adulto = await pacienteDePrueba({ nombre: 'Titular Recepcion', contacto: '+56973000001', createdAt: haceHoras(72) });
    pacientes.otro = await pacienteDePrueba({ nombre: 'Titular Otro', contacto: '+56973000002', createdAt: haceHoras(72) });
    const nino = new Date();
    nino.setFullYear(nino.getFullYear() - 8);
    pacientes.nino = await pacienteDePrueba({ nombre: 'Titular Nino', fechaNacimiento: nino.toISOString().slice(0, 10) });
  });

  afterAll(async () => {
    const ids = Object.values(pacientes).map((p) => p.id);
    await prisma.solicitudDerecho.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.verificacionIdentidad.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.paciente.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('el operador registra una rectificación con el valor propuesto cifrado y vencimiento a 30 días', async () => {
    const res = await registrar(pacientes.adulto, { derecho: 'rectificacion', canal: 'telefono', campo: 'nombre', valorPropuesto: 'Titular Corregido' });
    expect(res.status).toBe(200);
    const fila = await prisma.solicitudDerecho.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(fila).toMatchObject({ estado: 'recibida', identidadVerificada: false, canal: 'telefono', recibidaPorId: operador.id, campo: 'nombre' });
    expect(fila.venceEl.getTime() - fila.recibidaEl.getTime()).toBe(30 * DIA);
    expect(Buffer.from(fila.valorPropuestoCifrado).toString('latin1')).not.toContain('Corregido');
  });

  it('una solicitud sin verificar queda recibida: nunca se rechaza por eso', async () => {
    const res = await registrar(pacientes.otro, { derecho: 'acceso', canal: 'correo' });
    expect(res.status).toBe(200);
    expect((await prisma.solicitudDerecho.findUniqueOrThrow({ where: { id: res.body.id } })).estado).toBe('recibida');
  });

  it('una supresión no se verifica con código; con la cédula, sí, y guarda el método y quién verificó', async () => {
    const { body } = await registrar(pacientes.adulto, { derecho: 'supresion', canal: 'presencial' });
    await verificarPorCodigo(pacientes.adulto, '+56973000001');
    expect((await agente.post(`/pacientes/${pacientes.adulto.id}/solicitudes/${body.id}/verificar`).send({})).status).toBe(403);

    await verificacion.verificarConCedula(pacientes.adulto.id, solicitante());
    expect((await agente.post(`/pacientes/${pacientes.adulto.id}/solicitudes/${body.id}/verificar`).send({})).status).toBe(200);
    const fila = await prisma.solicitudDerecho.findUniqueOrThrow({ where: { id: body.id } });
    expect(fila).toMatchObject({ estado: 'verificada', identidadVerificada: true, metodoVerificacion: 'cedula_presencial', verificadaPorId: operador.id });
  });

  it('una rectificación sí se puede verificar con el código', async () => {
    const { body } = await registrar(pacientes.otro, { derecho: 'rectificacion', canal: 'telefono', campo: 'contacto', valorPropuesto: '+56973009999' });
    await verificarPorCodigo(pacientes.otro, '+56973000002');
    expect((await agente.post(`/pacientes/${pacientes.otro.id}/solicitudes/${body.id}/verificar`).send({})).status).toBe(200);
    expect((await prisma.solicitudDerecho.findUniqueOrThrow({ where: { id: body.id } })).metodoVerificacion).toBe('codigo_contacto');
  });

  it('no acepta un código si el contacto cambió después de recibir la solicitud', async () => {
    const { body } = await registrar(pacientes.otro, { derecho: 'acceso', canal: 'telefono' });
    await verificarPorCodigo(pacientes.otro, '+56973000002');
    await prisma.historialCambio.create({ data: { pacienteId: pacientes.otro.id, campo: 'contacto', cambiadoPorId: operador.id } });
    expect((await agente.post(`/pacientes/${pacientes.otro.id}/solicitudes/${body.id}/verificar`).send({})).status).toBe(403);
    await prisma.historialCambio.deleteMany({ where: { pacienteId: pacientes.otro.id } });
  });

  it('rechaza una rectificación de RUT con el dígito verificador inválido', async () => {
    const res = await registrar(pacientes.adulto, { derecho: 'rectificacion', canal: 'presencial', campo: 'rut', valorPropuesto: '12345678-0' });
    expect(res.status).toBe(400);
  });

  it('para un menor de 14 exige que lo pida su representante', async () => {
    expect((await registrar(pacientes.nino, { derecho: 'acceso', canal: 'presencial' })).status).toBe(400);
    const res = await registrar(pacientes.nino, { derecho: 'acceso', canal: 'presencial', solicitanteEsRepresentante: 'si', solicitanteRelacion: 'madre', solicitanteAcreditacion: 'certificado_nacimiento' });
    expect(res.status).toBe(200);
  });

  it('el médico y el gestor no registran solicitudes', async () => {
    const medico = await usuarioDePrueba('derechos-recepcion-medico@medibox.local', 'medico', password);
    const gestor = await usuarioDePrueba('derechos-recepcion-gestor@medibox.local', 'gestor', password);
    for (const usuario of [medico, gestor]) {
      const { agent } = await loginAgent(app, { email: usuario.email, password });
      expect((await agent.post(`/pacientes/${pacientes.adulto.id}/solicitudes`).send({ derecho: 'acceso', canal: 'presencial' })).status).toBe(403);
    }
  });

  it('SOLICITAR y VERIFICAR_SOLICITUD quedan en la auditoría del paciente', async () => {
    const acciones = await prisma.auditLog.findMany({ where: { entidad: 'Paciente', entidadId: pacientes.adulto.id }, select: { accion: true } });
    expect(acciones.map((a) => a.accion)).toEqual(expect.arrayContaining(['SOLICITAR', 'VERIFICAR_SOLICITUD']));
  });

  it('la ficha muestra las solicitudes sin el valor propuesto', async () => {
    const res = await agente.get(`/pacientes/${pacientes.adulto.id}`).set('Accept', 'text/html');
    expect(res.text).toContain('Solicitudes de derechos');
    expect(res.text).toContain('Supresión y bloqueo: solo con cédula');
    expect(res.text).not.toContain('Titular Corregido');
  });
});
