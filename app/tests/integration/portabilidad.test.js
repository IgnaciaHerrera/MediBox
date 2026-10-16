const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const { descifrar, cifrar } = require('../../src/lib/cifrado');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// Acceso y portabilidad (Hito 3): un JSON con todo lo del titular y nada de
// otras personas, generado con autenticación reciente del funcionario y
// entregado solo en persona o al contacto registrado.
describe('Acceso y portabilidad de los datos del titular', () => {
  const password = 'Password123!';
  let operador;
  let privacidad;
  let agente;
  let titular;
  let otro;
  let solicitud;

  async function reautenticar(agent) {
    return agent.post('/solicitudes/reautenticar').send({ password });
  }

  beforeAll(async () => {
    operador = await usuarioDePrueba('portabilidad-operador@medibox.local', 'operador', password);
    privacidad = await usuarioDePrueba('portabilidad-privacidad@medibox.local', 'privacidad', password);
    ({ agent: agente } = await loginAgent(app, { email: privacidad.email, password }));
    titular = await pacienteDePrueba({ nombre: 'Titular Portable', contacto: '+56975000001', createdAt: haceHoras(72) });
    otro = await pacienteDePrueba({ nombre: 'Vecino Ajeno', contacto: '+56975000002', createdAt: haceHoras(72) });

    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    const cita = (pacienteId, horaInicio, motivo) =>
      prisma.cita.create({
        data: { pacienteId, medicoId: medico.id, boxId: box.id, fecha: new Date('2099-07-01'), horaInicio, horaFin: `${horaInicio.slice(0, 3)}30`, motivoConsultaCifrado: cifrar('cita.motivoConsulta', motivo) },
      });
    await cita(titular.id, '01:00', 'Dolor de rodilla');
    await cita(otro.id, '02:00', 'Motivo del vecino');

    solicitud = await solicitudDePrueba(titular, operador, { derecho: 'portabilidad' }, { metodo: 'cedula' });
  });

  afterAll(async () => {
    await limpiarPacientes([titular.id, otro.id]);
    await prisma.$disconnect();
  });

  it('sin reautenticación reciente no se genera el archivo', async () => {
    expect((await agente.post(`/solicitudes/${solicitud.id}/descargar`).send({ entrega: 'presencial' })).status).toBe(403);
  });

  it('una contraseña incorrecta no reautentica', async () => {
    expect((await agente.post('/solicitudes/reautenticar').send({ password: 'Incorrecta123' })).status).toBe(401);
  });

  it('no se entrega al contacto registrado si cambió después de la solicitud', async () => {
    await reautenticar(agente);
    await prisma.historialCambio.create({ data: { pacienteId: titular.id, campo: 'contacto', cambiadoPorId: operador.id } });
    expect((await agente.post(`/solicitudes/${solicitud.id}/descargar`).send({ entrega: 'contacto_registrado' })).status).toBe(409);
    await prisma.historialCambio.deleteMany({ where: { pacienteId: titular.id } });
  });

  it('genera el JSON del titular, sin nada de otra persona ni datos internos', async () => {
    await reautenticar(agente);
    const res = await agente.post(`/solicitudes/${solicitud.id}/descargar`).send({ entrega: 'presencial' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="datos-titular-\d+\.json"/);

    const datos = JSON.parse(res.text);
    expect(datos.titular).toMatchObject({ nombre: 'Titular Portable', rut: descifrar('paciente.rut', titular.rutCifrado), contacto: '+56975000001' });
    expect(datos.citas).toEqual([expect.objectContaining({ fecha: '2099-07-01', horaInicio: '01:00', motivoConsulta: 'Dolor de rodilla' })]);
    expect(Array.isArray(datos.consentimientos)).toBe(true);
    expect(datos.solicitudes.map((s) => s.derecho)).toContain('portabilidad');
    expect(Array.isArray(datos.historialCambios)).toBe(true);
    expect(datos.accesos.length).toBeGreaterThan(0);
    expect(datos.tratamiento.finalidades.length).toBeGreaterThan(0);

    expect(res.text).not.toContain('Vecino Ajeno');
    expect(res.text).not.toContain('Motivo del vecino');
    expect(res.text).not.toContain(descifrar('paciente.rut', otro.rutCifrado));
    // Sin ids internos ni nombres de funcionarios: el acceso muestra el rol.
    expect(res.text).not.toMatch(/"(id|pacienteId|usuarioId|medicoId|boxId)":/);
    expect(res.text).not.toContain(privacidad.nombre);
    expect(datos.accesos.every((a) => typeof a.rol === 'string')).toBe(true);
  });

  it('la solicitud queda resuelta con su entrega y la exportación en la auditoría', async () => {
    const resuelta = await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } });
    expect(resuelta).toMatchObject({ estado: 'resuelta', entrega: 'presencial', resueltaPorId: privacidad.id });
    const fila = await prisma.auditLog.findFirst({ where: { accion: 'EXPORT_TITULAR', entidadId: titular.id }, orderBy: { id: 'desc' } });
    expect(fila.detalle).toMatchObject({ entrega: 'presencial', solicitudId: solicitud.id });
  });
});
