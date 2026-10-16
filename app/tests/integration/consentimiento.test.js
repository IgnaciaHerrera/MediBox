const { prisma } = require('../../src/lib/prisma');
const { usuarioDePrueba, pacienteDePrueba, rutAleatorio } = require('../helpers/datos');
const consentimiento = require('../../src/services/consentimientoService');
const verificacion = require('../../src/services/verificacionService');
const canalEnvio = require('../../src/lib/canalEnvio');
const { crearCita } = require('../../src/services/citaService');

// Consentimiento por finalidad (Hito 3): solo para las finalidades
// secundarias de D1; la atención no depende de él. Cada otorgamiento es una
// fila con la versión exacta del texto, el canal, quién lo registró y la
// verificación de identidad que lo respalda. Revocar no borra nada.
describe('Consentimiento por finalidad', () => {
  const password = 'Password123!';
  let funcionario;
  let solicitante;
  const pacientes = {};
  const citas = [];

  const haceAnios = (anios) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - anios);
    return d.toISOString().slice(0, 10);
  };

  async function textoVigente(clave) {
    const estado = await consentimiento.estadoPorPaciente(pacientes.adulto.id);
    return estado.find((e) => e.finalidad.clave === clave).textoVigente;
  }

  async function verificar(paciente) {
    await verificacion.verificarConCedula(paciente.id, solicitante);
  }

  beforeAll(async () => {
    funcionario = await usuarioDePrueba('consentimiento-operador@medibox.local', 'operador', password);
    solicitante = { id: funcionario.id, permisos: ['paciente.read', 'consentimiento.write'] };
    // Registrado hace días: el código solo va a un contacto estable.
    pacientes.adulto = await pacienteDePrueba({ nombre: 'Consent Adulto', fechaNacimiento: '1985-05-05', contacto: '+56971000001', createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000) });
    pacientes.nino = await pacienteDePrueba({ nombre: 'Consent Nino', fechaNacimiento: haceAnios(9) });
    pacientes.adolescente = await pacienteDePrueba({ nombre: 'Consent Adolescente', fechaNacimiento: haceAnios(16) });
  });

  afterAll(async () => {
    const ids = Object.values(pacientes).map((p) => p.id);
    await prisma.cita.deleteMany({ where: { id: { in: citas } } });
    await prisma.consentimiento.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.textoConsentimiento.deleteMany({ where: { texto: { startsWith: 'TEXTO DE PRUEBA' } } });
    await prisma.verificacionIdentidad.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.paciente.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('las tres finalidades de D1 existen y parten sin otorgar', async () => {
    const estado = await consentimiento.estadoPorPaciente(pacientes.adulto.id);
    expect(estado.map((e) => e.finalidad.clave).sort()).toEqual(['encuestas', 'investigacion', 'recordatorios']);
    estado.forEach((e) => {
      expect(e.estado).toBe('sin_otorgar');
      expect(e.textoVigente.texto.length).toBeGreaterThan(50);
    });
  });

  it('sin una verificación vigente no se puede otorgar ni revocar', async () => {
    const otro = await usuarioDePrueba('consentimiento-otro@medibox.local', 'operador', password);
    const s = { id: otro.id, permisos: solicitante.permisos };
    const texto = await textoVigente('encuestas');
    await expect(consentimiento.otorgar({ pacienteId: pacientes.adulto.id, finalidadClave: 'encuestas', textoId: texto.id, canal: 'telefono' }, s)).rejects.toMatchObject({ statusCode: 403 });
    await expect(consentimiento.revocar({ pacienteId: pacientes.adulto.id, finalidadClave: 'encuestas', canal: 'telefono' }, s)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('otorgar y revocar una finalidad no toca las otras, y revocar conserva la fila', async () => {
    await verificar(pacientes.adulto);
    const textoR = await textoVigente('recordatorios');
    const textoE = await textoVigente('encuestas');
    const { id } = await consentimiento.otorgar({ pacienteId: pacientes.adulto.id, finalidadClave: 'recordatorios', textoId: textoR.id, canal: 'presencial' }, solicitante);
    await consentimiento.otorgar({ pacienteId: pacientes.adulto.id, finalidadClave: 'encuestas', textoId: textoE.id, canal: 'presencial' }, solicitante);

    await consentimiento.revocar({ pacienteId: pacientes.adulto.id, finalidadClave: 'recordatorios', canal: 'correo' }, solicitante);

    expect(await consentimiento.tieneVigente(pacientes.adulto.id, 'recordatorios')).toBe(false);
    expect(await consentimiento.tieneVigente(pacientes.adulto.id, 'encuestas')).toBe(true);
    const fila = await prisma.consentimiento.findUnique({ where: { id } });
    expect(fila).toMatchObject({ canal: 'presencial', revocacionCanal: 'correo', registradoPorId: funcionario.id, revocacionRegistradaPorId: funcionario.id });
    expect(fila.revocadoEl).toBeInstanceOf(Date);
  });

  it('se puede otorgar verificando por código y revocar verificando con cédula; cada fila guarda su verificación', async () => {
    await verificacion.enviarCodigo(pacientes.adulto.id, solicitante);
    const codigo = canalEnvio.ultimo('+56971000001').mensaje.match(/\b(\d{6})\b/)[1];
    const { verificacionId } = await verificacion.confirmarCodigo(pacientes.adulto.id, codigo, solicitante);
    const texto = await textoVigente('investigacion');
    const { id } = await consentimiento.otorgar({ pacienteId: pacientes.adulto.id, finalidadClave: 'investigacion', textoId: texto.id, canal: 'telefono' }, solicitante);

    await verificar(pacientes.adulto);
    await consentimiento.revocar({ pacienteId: pacientes.adulto.id, finalidadClave: 'investigacion', canal: 'presencial' }, solicitante);

    const fila = await prisma.consentimiento.findUnique({ where: { id }, include: { revocacionVerificacion: true } });
    expect(fila.verificacionId).toBe(verificacionId);
    expect(fila.revocacionVerificacion.metodo).toBe('cedula_presencial');
  });

  it('una versión nueva del texto deja el consentimiento a renovar y detiene el tratamiento', async () => {
    await verificar(pacientes.adulto);
    const finalidad = await prisma.finalidad.findUniqueOrThrow({ where: { clave: 'encuestas' } });
    expect(await consentimiento.tieneVigente(pacientes.adulto.id, 'encuestas')).toBe(true);
    const viejo = await textoVigente('encuestas');

    const nuevo = await prisma.textoConsentimiento.create({ data: { finalidadId: finalidad.id, version: viejo.version + 1, texto: 'TEXTO DE PRUEBA versión nueva de las encuestas' } });
    const estado = (await consentimiento.estadoPorPaciente(pacientes.adulto.id)).find((e) => e.finalidad.clave === 'encuestas');
    expect(estado.estado).toBe('a_renovar');
    expect(await consentimiento.tieneVigente(pacientes.adulto.id, 'encuestas')).toBe(false);

    // Otorgar con el texto anterior ya no se acepta; con el nuevo, sí.
    await expect(consentimiento.otorgar({ pacienteId: pacientes.adulto.id, finalidadClave: 'encuestas', textoId: viejo.id, canal: 'telefono' }, solicitante)).rejects.toMatchObject({ statusCode: 400 });
    await consentimiento.otorgar({ pacienteId: pacientes.adulto.id, finalidadClave: 'encuestas', textoId: nuevo.id, canal: 'telefono' }, solicitante);
    expect(await consentimiento.tieneVigente(pacientes.adulto.id, 'encuestas')).toBe(true);
    await prisma.consentimiento.deleteMany({ where: { textoId: nuevo.id } });
    await prisma.textoConsentimiento.delete({ where: { id: nuevo.id } });
  });

  it('para un menor de 14 exige al representante y lo guarda cifrado', async () => {
    await verificar(pacientes.nino);
    const texto = await textoVigente('recordatorios');
    const base = { pacienteId: pacientes.nino.id, finalidadClave: 'recordatorios', textoId: texto.id, canal: 'presencial' };
    await expect(consentimiento.otorgar(base, solicitante)).rejects.toMatchObject({ statusCode: 400 });

    const rut = rutAleatorio();
    const { id } = await consentimiento.otorgar({ ...base, representante: { nombre: 'Marta Representante', rut, relacion: 'madre' } }, solicitante);
    const fila = await prisma.consentimiento.findUnique({ where: { id } });
    expect(fila.otorgadoPor).toBe('representante');
    const crudo = Buffer.from(fila.representanteCifrado).toString('latin1');
    expect(crudo).not.toContain('Marta');
    expect(crudo).not.toContain(rut.split('-')[0]);
  });

  it('un adolescente de 16 otorga como titular', async () => {
    await verificar(pacientes.adolescente);
    const texto = await textoVigente('encuestas');
    const { id } = await consentimiento.otorgar({ pacienteId: pacientes.adolescente.id, finalidadClave: 'encuestas', textoId: texto.id, canal: 'presencial' }, solicitante);
    expect((await prisma.consentimiento.findUnique({ where: { id } })).otorgadoPor).toBe('titular');
  });

  it('CONSENTIR y REVOCAR quedan en la auditoría del paciente', async () => {
    const acciones = await prisma.auditLog.findMany({ where: { entidad: 'Paciente', entidadId: pacientes.adulto.id, accion: { in: ['CONSENTIR', 'REVOCAR'] } } });
    expect(acciones.map((a) => a.accion)).toEqual(expect.arrayContaining(['CONSENTIR', 'REVOCAR']));
    acciones.forEach((a) => expect(a.usuarioId).toBe(funcionario.id));
  });

  it('la atención no depende del consentimiento: se agenda a un paciente sin ninguno', async () => {
    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    const dia = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
    const cita = await crearCita(
      { pacienteId: pacientes.adolescente.id, medicoId: medico.id, boxId: box.id, fecha: `2099-03-${dia}`, horaInicio: '06:00', horaFin: '06:15', motivoConsulta: 'Control' },
      funcionario.id,
    );
    citas.push(cita.id);
    expect(cita.id).toBeDefined();
  });
});
