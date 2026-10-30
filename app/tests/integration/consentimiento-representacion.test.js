const { prisma } = require('../../src/lib/prisma');
const { usuarioDePrueba, pacienteDePrueba, rutAleatorio } = require('../helpers/datos');
const { limpiarPacientes } = require('../helpers/derechos');
const consentimiento = require('../../src/services/consentimientoService');
const verificacion = require('../../src/services/verificacionService');
const derechos = require('../../src/services/derechosService');
const canalEnvio = require('../../src/lib/canalEnvio');
const { enviarInvitacionesEncuesta } = require('../../src/services/recordatorioService');

// Consentimiento de adolescentes (Ley 21.719, art. 16 quáter), acreditación
// de la representación, historial de consentimientos y el proceso de
// encuestas, que consulta solo su propia finalidad.
describe('Consentimiento: adolescentes, representación, historial y encuestas', () => {
  const password = 'Password123!';
  const FECHA_ATENCION = '2099-06-15';
  let operador;
  let solicitante;
  const pacientes = {};
  const citas = [];

  const haceAnios = (anios) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - anios);
    d.setDate(d.getDate() - 10);
    return d.toISOString().slice(0, 10);
  };
  const representante = (documento = 'certificado_nacimiento') => ({ nombre: 'Rosa Representante', rut: rutAleatorio(), relacion: 'madre', documento });

  async function textoDe(paciente, clave) {
    return (await consentimiento.estadoPorPaciente(paciente.id)).find((e) => e.finalidad.clave === clave).textoVigente;
  }

  async function otorgar(paciente, clave, extra = {}) {
    await verificacion.verificarConCedula(paciente.id, solicitante);
    const texto = await textoDe(paciente, clave);
    return consentimiento.otorgar({ pacienteId: paciente.id, finalidadClave: clave, textoId: texto.id, canal: 'presencial', ...extra }, solicitante);
  }

  async function atendidoEl(paciente, fecha) {
    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    const cita = await prisma.cita.create({ data: { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: new Date(fecha), horaInicio: '05:00', horaFin: '05:20', estado: 'atendido' } });
    citas.push(cita.id);
  }

  beforeAll(async () => {
    operador = await usuarioDePrueba('representacion-operador@medibox.local', 'operador', password);
    solicitante = { id: operador.id, permisos: ['paciente.read', 'consentimiento.write', 'derechos.registrar'] };
    pacientes.quince = await pacienteDePrueba({ nombre: 'Rep Quince', fechaNacimiento: haceAnios(15) });
    pacientes.diecisiete = await pacienteDePrueba({ nombre: 'Rep Diecisiete', fechaNacimiento: haceAnios(17) });
    pacientes.nino = await pacienteDePrueba({ nombre: 'Rep Nino', fechaNacimiento: haceAnios(8) });
    pacientes.adulto = await pacienteDePrueba({ nombre: 'Rep Adulto', fechaNacimiento: '1980-02-02' });
    pacientes.soloRecordatorios = await pacienteDePrueba({ nombre: 'Enc Solo Recordatorios', contacto: '+56973000001' });
    pacientes.conEncuestas = await pacienteDePrueba({ nombre: 'Enc Con Encuestas', contacto: '+56973000002' });
    pacientes.revoco = await pacienteDePrueba({ nombre: 'Enc Revoco', contacto: '+56973000003' });
  });

  afterAll(async () => {
    await prisma.cita.deleteMany({ where: { id: { in: citas } } });
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  describe('adolescentes y datos sensibles', () => {
    it('las tres finalidades tratan datos sensibles', async () => {
      const estado = await consentimiento.estadoPorPaciente(pacientes.adulto.id);
      expect(estado.every((e) => e.finalidad.datosSensibles)).toBe(true);
    });

    it('un adolescente de 15 no consiente solo un uso con datos de salud: lo hace su representante', async () => {
      await expect(otorgar(pacientes.quince, 'investigacion')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('menor de 16') });
      const { id } = await otorgar(pacientes.quince, 'investigacion', { representante: representante() });
      expect((await prisma.consentimiento.findUnique({ where: { id } })).otorgadoPor).toBe('representante');
    });

    it('la regla de los 16 depende de la finalidad: una sin datos sensibles la consiente el adolescente', () => {
      expect(consentimiento.requiereRepresentante(15, { datosSensibles: true })).toBe(true);
      expect(consentimiento.requiereRepresentante(15, { datosSensibles: false })).toBe(false);
      expect(consentimiento.requiereRepresentante(13, { datosSensibles: false })).toBe(true);
      expect(consentimiento.requiereRepresentante(16, { datosSensibles: true })).toBe(false);
    });

    it('un adolescente de 17 consiente él mismo', async () => {
      const { id } = await otorgar(pacientes.diecisiete, 'investigacion');
      expect((await prisma.consentimiento.findUnique({ where: { id } })).otorgadoPor).toBe('titular');
    });
  });

  describe('acreditación de la representación', () => {
    it('sin el documento, o declarado en admisión, no se registra', async () => {
      const { documento, ...sinDocumento } = representante();
      expect(documento).toBeDefined();
      await expect(otorgar(pacientes.nino, 'recordatorios', { representante: sinDocumento })).rejects.toMatchObject({ statusCode: 400 });
      await expect(otorgar(pacientes.nino, 'recordatorios', { representante: representante('declarada') })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('por teléfono queda declarada; se guarda el tipo de documento, cifrado con los datos del representante', async () => {
      const { id } = await otorgar(pacientes.nino, 'encuestas', { canal: 'telefono', representante: representante('declarada') });
      const [h] = (await consentimiento.historialPorPaciente(pacientes.nino.id)).filter((f) => f.finalidad === 'Encuestas de satisfacción');
      expect(h).toMatchObject({ otorgadoPor: 'representante', relacion: 'madre', documento: 'declarada' });
      const crudo = Buffer.from((await prisma.consentimiento.findUnique({ where: { id } })).representanteCifrado).toString('latin1');
      expect(crudo).not.toContain('declarada');
    });

    it('una supresión pedida por teléfono por un representante no se verifica sin el documento', async () => {
      const { id } = await derechos.registrarSolicitud(
        { pacienteId: pacientes.nino.id, derecho: 'supresion', canal: 'telefono', solicitanteEsRepresentante: 'si', solicitanteRelacion: 'padre' },
        solicitante,
      );
      expect((await prisma.solicitudDerecho.findUnique({ where: { id } })).solicitanteAcreditacion).toBe('declarada');
      await verificacion.verificarConCedula(pacientes.nino.id, solicitante);
      await expect(derechos.verificarSolicitud(id, solicitante)).rejects.toMatchObject({ statusCode: 409 });
      await derechos.verificarSolicitud(id, solicitante, { documento: 'certificado_nacimiento' });
      expect(await prisma.solicitudDerecho.findUnique({ where: { id } })).toMatchObject({ estado: 'verificada', solicitanteAcreditacion: 'certificado_nacimiento' });
    });

    it('un apoderado de un adulto acredita con un poder notarial, y nada más', async () => {
      const base = { pacienteId: pacientes.adulto.id, derecho: 'acceso', canal: 'presencial', solicitanteEsRepresentante: 'si', solicitanteRelacion: 'apoderado' };
      await expect(derechos.registrarSolicitud({ ...base, solicitanteAcreditacion: 'certificado_nacimiento' }, solicitante)).rejects.toMatchObject({ statusCode: 400 });
      await expect(derechos.registrarSolicitud(base, solicitante)).rejects.toMatchObject({ statusCode: 400 });
      const { id } = await derechos.registrarSolicitud({ ...base, solicitanteAcreditacion: 'poder_notarial' }, solicitante);
      await verificacion.verificarConCedula(pacientes.adulto.id, solicitante);
      await derechos.verificarSolicitud(id, solicitante);
      expect((await prisma.solicitudDerecho.findUnique({ where: { id } })).estado).toBe('verificada');
    });
  });

  it('el historial muestra cada otorgamiento y su revocación, del más reciente al más antiguo', async () => {
    await otorgar(pacientes.adulto, 'recordatorios');
    await verificacion.verificarConCedula(pacientes.adulto.id, solicitante);
    await consentimiento.revocar({ pacienteId: pacientes.adulto.id, finalidadClave: 'recordatorios', canal: 'correo' }, solicitante);
    await otorgar(pacientes.adulto, 'recordatorios');

    const historial = (await consentimiento.historialPorPaciente(pacientes.adulto.id)).filter((h) => h.finalidad === 'Recordatorios de citas');
    expect(historial).toHaveLength(2);
    expect(historial[0]).toMatchObject({ revocadoEl: null, otorgadoPor: 'titular', metodoVerificacion: 'cedula_presencial', registradoPor: operador.nombre });
    expect(historial[1]).toMatchObject({ revocacionCanal: 'correo', revocacionRegistradaPor: operador.nombre });
    expect(historial[1].revocadoEl).toBeInstanceOf(Date);
    expect(historial[0]).not.toHaveProperty('nombre');
  });

  describe('encuestas: cada finalidad se consulta por separado', () => {
    beforeAll(async () => {
      await otorgar(pacientes.soloRecordatorios, 'recordatorios');
      await otorgar(pacientes.conEncuestas, 'encuestas');
      await otorgar(pacientes.revoco, 'encuestas');
      await verificacion.verificarConCedula(pacientes.revoco.id, solicitante);
      await consentimiento.revocar({ pacienteId: pacientes.revoco.id, finalidadClave: 'encuestas', canal: 'telefono' }, solicitante);
      for (const p of [pacientes.soloRecordatorios, pacientes.conEncuestas, pacientes.revoco]) await atendidoEl(p, FECHA_ATENCION);
      // Dos atenciones el mismo día: una sola invitación.
      await atendidoEl(pacientes.conEncuestas, FECHA_ATENCION);
    });

    it('invita solo a quien tiene vigente "encuestas", una vez, sin datos de la atención', async () => {
      const antes = (p) => canalEnvio.ultimo(p);
      const previos = ['+56973000001', '+56973000003'].map(antes);
      const resumen = await enviarInvitacionesEncuesta({ fecha: FECHA_ATENCION });
      expect(resumen).toEqual({ enviados: 1, sinCanal: 0 });

      const mensaje = canalEnvio.ultimo('+56973000002').mensaje;
      expect(mensaje).toContain('15-06-2099');
      expect(mensaje).not.toMatch(/Dr|médico|motivo/i);
      // Consentir los recordatorios no habilita las encuestas, y revocar las detiene.
      expect(['+56973000001', '+56973000003'].map(antes)).toEqual(previos);
    });

    it('queda en la auditoría solo el conteo', async () => {
      const fila = await prisma.auditLog.findFirst({ where: { accion: 'ENCUESTA' }, orderBy: { id: 'desc' } });
      expect(fila).toMatchObject({ actor: 'sistema', entidad: 'Sistema', detalle: { enviados: 1, sinCanal: 0 } });
    });
  });
});
