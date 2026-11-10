const fs = require('fs');
const os = require('os');
const path = require('path');
const { prisma } = require('../../src/lib/prisma');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const derechos = require('../../src/services/derechosService');
const consentimiento = require('../../src/services/consentimientoService');
const verificacion = require('../../src/services/verificacionService');
const { reaplicar } = require('../../src/services/supresionService');
const { podarAnotaciones } = require('../../src/services/anotacionService');

const DIA = 24 * 60 * 60 * 1000;

// Un respaldo anterior no debe deshacer lo que el titular ya pidió: además de
// la supresión, el bloqueo, su levantamiento y las revocaciones u oposiciones
// quedan anotados fuera de la base y se reaplican al restaurar.
describe('Bloqueos y revocaciones que sobreviven a una restauración', () => {
  const password = 'Password123!';
  const archivo = path.join(os.tmpdir(), `medibox-restricciones-${process.pid}-${Date.now()}.jsonl`);
  const archivoAnterior = process.env.SUPRESIONES_ARCHIVO;
  const pacientes = {};
  let operador;
  let privacidad;
  let cedula;

  const lineas = () => fs.readFileSync(archivo, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const deLaPaciente = (clave) => lineas().filter((l) => l.pacienteId === pacientes[clave].id);

  async function otorgar(paciente, clave) {
    await verificacion.verificarConCedula(paciente.id, cedula);
    const estado = (await consentimiento.estadoPorPaciente(paciente.id)).find((e) => e.finalidad.clave === clave);
    await consentimiento.otorgar({ pacienteId: paciente.id, finalidadClave: clave, textoId: estado.textoVigente.id, canal: 'presencial' }, cedula);
  }

  const abiertos = async (paciente) =>
    (await prisma.consentimiento.findMany({ where: { pacienteId: paciente.id, revocadoEl: null }, include: { finalidad: true } })).map((c) => c.finalidad.clave).sort();

  beforeAll(async () => {
    process.env.SUPRESIONES_ARCHIVO = archivo;
    operador = await usuarioDePrueba('restricciones-operador@medibox.local', 'operador', password);
    const usuario = await usuarioDePrueba('restricciones-privacidad@medibox.local', 'privacidad', password);
    privacidad = { id: usuario.id, permisos: ['derechos.registrar', 'derechos.gestionar'] };
    cedula = { id: operador.id, permisos: ['paciente.read', 'consentimiento.write'] };
    for (const clave of ['bloqueada', 'desbloqueada', 'oposicion', 'directa', 'reotorgada', 'fallida']) {
      pacientes[clave] = await pacienteDePrueba({ nombre: `Restriccion ${clave}`, contacto: `+5697800${String(Object.keys(pacientes).length).padStart(4, '0')}` });
    }
  });

  afterAll(async () => {
    process.env.SUPRESIONES_ARCHIVO = archivoAnterior;
    fs.rmSync(archivo, { force: true });
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('un bloqueo y su levantamiento quedan anotados, solo con ids, fecha y tipo', async () => {
    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    await prisma.cita.create({ data: { pacienteId: pacientes.bloqueada.id, medicoId: medico.id, boxId: box.id, fecha: new Date('2099-08-01'), horaInicio: '05:00', horaFin: '05:15' } });

    const bloqueo = await solicitudDePrueba(pacientes.bloqueada, operador, { derecho: 'bloqueo' }, { metodo: 'cedula' });
    await derechos.ejecutar(bloqueo.id, privacidad, { respuesta: 'Bloqueado mientras se aclara.' });
    expect(deLaPaciente('bloqueada')).toEqual([{ tipo: 'bloqueo', pacienteId: pacientes.bloqueada.id, fecha: expect.any(String), solicitudId: bloqueo.id }]);

    const otro = await solicitudDePrueba(pacientes.desbloqueada, operador, { derecho: 'bloqueo' }, { metodo: 'cedula' });
    await derechos.ejecutar(otro.id, privacidad, { respuesta: 'Bloqueado mientras se aclara.' });
    await derechos.desbloquear(otro.id, privacidad);
    expect(deLaPaciente('desbloqueada').map((l) => l.tipo)).toEqual(['bloqueo', 'desbloqueo']);
  });

  it('una oposición y una revocación directa anotan el uso y el canal, sin datos personales', async () => {
    await otorgar(pacientes.oposicion, 'recordatorios');
    await otorgar(pacientes.oposicion, 'encuestas');
    const solicitud = await solicitudDePrueba(pacientes.oposicion, operador, { derecho: 'oposicion', finalidadClave: 'recordatorios' }, { metodo: 'cedula' });
    await derechos.ejecutar(solicitud.id, privacidad, { respuesta: 'No se le enviarán recordatorios.' });
    expect(deLaPaciente('oposicion')).toEqual([
      { tipo: 'revocacion', pacienteId: pacientes.oposicion.id, fecha: expect.any(String), solicitudId: solicitud.id, finalidad: 'recordatorios', canal: 'presencial' },
    ]);

    await otorgar(pacientes.directa, 'encuestas');
    await consentimiento.revocar({ pacienteId: pacientes.directa.id, finalidadClave: 'encuestas', canal: 'telefono' }, cedula);
    expect(deLaPaciente('directa')).toEqual([
      { tipo: 'revocacion', pacienteId: pacientes.directa.id, fecha: expect.any(String), finalidad: 'encuestas', canal: 'telefono' },
    ]);
  });

  it('revocar algo que no estaba otorgado no deja anotación', async () => {
    await consentimiento.revocar({ pacienteId: pacientes.directa.id, finalidadClave: 'investigacion', canal: 'telefono' }, cedula);
    expect(deLaPaciente('directa')).toHaveLength(1);
  });

  it('un consentimiento otorgado después de la revocación se conserva al reaplicar', async () => {
    await otorgar(pacientes.reotorgada, 'recordatorios');
    await consentimiento.revocar({ pacienteId: pacientes.reotorgada.id, finalidadClave: 'recordatorios', canal: 'presencial' }, cedula);
    await otorgar(pacientes.reotorgada, 'recordatorios');
    expect(await abiertos(pacientes.reotorgada)).toEqual(['recordatorios']);
  });

  it('reaplicar deja todo como lo pidió el titular tras restaurar un respaldo anterior', async () => {
    // Lo que traería un respaldo previo a esos pedidos.
    await prisma.paciente.update({ where: { id: pacientes.bloqueada.id }, data: { bloqueado: false, bloqueadoEl: null } });
    await prisma.cita.updateMany({ where: { pacienteId: pacientes.bloqueada.id }, data: { anulada: false } });
    await prisma.paciente.update({ where: { id: pacientes.desbloqueada.id }, data: { bloqueado: true, bloqueadoEl: new Date() } });
    await prisma.consentimiento.updateMany({ where: { pacienteId: { in: [pacientes.oposicion.id, pacientes.directa.id] } }, data: { revocadoEl: null, revocacionCanal: null } });

    expect(await reaplicar()).toEqual({ reaplicadas: 4 });

    const bloqueada = await prisma.paciente.findUnique({ where: { id: pacientes.bloqueada.id } });
    expect(bloqueada.bloqueado).toBe(true);
    expect(await prisma.cita.count({ where: { pacienteId: pacientes.bloqueada.id, anulada: true } })).toBe(1);
    expect((await prisma.paciente.findUnique({ where: { id: pacientes.desbloqueada.id } })).bloqueado).toBe(false);

    // La oposición revoca solo el uso pedido; la revocación directa, el suyo.
    expect(await abiertos(pacientes.oposicion)).toEqual(['encuestas']);
    expect(await abiertos(pacientes.directa)).toEqual([]);
    const revocado = await prisma.consentimiento.findFirst({ where: { pacienteId: pacientes.directa.id, finalidad: { clave: 'encuestas' } } });
    expect(revocado).toMatchObject({ revocacionCanal: 'telefono' });
    expect(revocado.revocadoEl).not.toBeNull();

    // Lo otorgado después de revocar no se toca.
    expect(await abiertos(pacientes.reotorgada)).toEqual(['recordatorios']);

    const fila = await prisma.auditLog.findFirst({ where: { accion: 'REAPLICAR_RESTRICCION', entidadId: pacientes.bloqueada.id }, orderBy: { id: 'desc' } });
    expect(fila).toMatchObject({ actor: 'sistema', usuarioId: null, detalle: expect.objectContaining({ bloqueo: 1, citas: 1 }) });
  });

  it('correrlo de nuevo no cambia nada', async () => {
    expect(await reaplicar()).toEqual({ reaplicadas: 0 });
  });

  it('si no se puede anotar, la solicitud igual se cierra y queda un fallo en la auditoría', async () => {
    const directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'medibox-no-escribible-'));
    process.env.SUPRESIONES_ARCHIVO = directorio; // un directorio: escribir falla
    try {
      const solicitud = await solicitudDePrueba(pacientes.fallida, operador, { derecho: 'bloqueo' }, { metodo: 'cedula' });
      await derechos.ejecutar(solicitud.id, privacidad, { respuesta: 'Bloqueado mientras se aclara.' });
      expect((await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).estado).toBe('resuelta');
      expect((await prisma.paciente.findUnique({ where: { id: pacientes.fallida.id } })).bloqueado).toBe(true);
      const fila = await prisma.auditLog.findFirst({ where: { accion: 'ANOTAR_RESTRICCION', entidadId: pacientes.fallida.id } });
      expect(fila).toMatchObject({ actor: 'sistema', resultado: 'fallido', detalle: { tipo: 'bloqueo', solicitudId: solicitud.id } });
    } finally {
      process.env.SUPRESIONES_ARCHIVO = archivo;
      fs.rmSync(directorio, { recursive: true, force: true });
    }
  });

  describe('poda a la vigencia de los respaldos', () => {
    const podable = path.join(os.tmpdir(), `medibox-podable-${process.pid}-${Date.now()}.jsonl`);
    const antes = process.env.MEDIBOX_RESPALDO_DIAS;
    const hace = (dias, ahora) => new Date(ahora.getTime() - dias * DIA).toISOString();

    afterEach(() => {
      process.env.SUPRESIONES_ARCHIVO = archivo;
      if (antes === undefined) delete process.env.MEDIBOX_RESPALDO_DIAS;
      else process.env.MEDIBOX_RESPALDO_DIAS = antes;
      fs.rmSync(podable, { force: true });
    });

    it('elimina lo anotado hace más de 30 días (y un día de margen) y conserva lo reciente', () => {
      process.env.SUPRESIONES_ARCHIVO = podable;
      const ahora = new Date();
      const filas = [
        { pacienteId: 1, fecha: hace(40, ahora), solicitudId: 1 },
        { tipo: 'bloqueo', pacienteId: 2, fecha: hace(31.5, ahora), solicitudId: 2 },
        { tipo: 'bloqueo', pacienteId: 3, fecha: hace(30.5, ahora), solicitudId: 3 },
        { tipo: 'revocacion', pacienteId: 4, fecha: hace(2, ahora), finalidad: 'encuestas', canal: 'portal' },
      ];
      fs.writeFileSync(podable, filas.map((f) => `${JSON.stringify(f)}\n`).join(''));

      expect(podarAnotaciones(ahora)).toBe(2);
      expect(fs.readFileSync(podable, 'utf8').trim().split('\n').map((l) => JSON.parse(l).pacienteId)).toEqual([3, 4]);
      expect(podarAnotaciones(ahora)).toBe(0);
    });

    it('respeta MEDIBOX_RESPALDO_DIAS, la misma variable que usa el respaldo', () => {
      process.env.SUPRESIONES_ARCHIVO = podable;
      process.env.MEDIBOX_RESPALDO_DIAS = '90';
      const ahora = new Date();
      fs.writeFileSync(podable, `${JSON.stringify({ tipo: 'bloqueo', pacienteId: 1, fecha: hace(60, ahora) })}\n`);
      expect(podarAnotaciones(ahora)).toBe(0);
    });

    it('sin archivo no hace nada', () => {
      process.env.SUPRESIONES_ARCHIVO = `${podable}.no-existe`;
      expect(podarAnotaciones()).toBe(0);
    });
  });
});
