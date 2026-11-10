const fs = require('fs');
const os = require('os');
const path = require('path');
const { prisma } = require('../../src/lib/prisma');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const consentimiento = require('../../src/services/consentimientoService');
const verificacion = require('../../src/services/verificacionService');
const { candidatos, depurar, ANIOS_FICHA } = require('../../src/services/depuracionService');
const { reaplicar } = require('../../src/services/supresionService');
const { anotarRestriccion } = require('../../src/services/anotacionService');

const haceAnios = (anios, desde = new Date()) => {
  const d = new Date(desde);
  d.setFullYear(d.getFullYear() - anios);
  return d;
};

// Los datos bloqueados se conservan al menos 15 años (Ley 20.584, art. 13) y
// después se eliminan de verdad: el plazo cuenta desde la última atención. La
// depuración la corre el dueño de la base (la aplicación no puede borrar
// pacientes) y la autoriza alguien de privacidad.
describe('Depuración de lo bloqueado al cumplirse el plazo legal', () => {
  const password = 'Password123!';
  const archivo = path.join(os.tmpdir(), `medibox-depuracion-${process.pid}-${Date.now()}.jsonl`);
  const archivoAnterior = process.env.SUPRESIONES_ARCHIVO;
  const pacientes = {};
  const ahora = new Date();
  let operador;
  let privacidad;

  const lineas = () => (fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ids = (...claves) => claves.map((c) => pacientes[c].id);
  const dependientes = async (pacienteId) => ({
    citas: await prisma.cita.count({ where: { pacienteId } }),
    consentimientos: await prisma.consentimiento.count({ where: { pacienteId } }),
    solicitudes: await prisma.solicitudDerecho.count({ where: { pacienteId } }),
    historial: await prisma.historialCambio.count({ where: { pacienteId } }),
    verificaciones: await prisma.verificacionIdentidad.count({ where: { pacienteId } }),
  });

  async function cita(paciente, fecha, extra = {}) {
    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    return prisma.cita.create({ data: { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha, horaInicio: '06:00', horaFin: '06:15', ...extra } });
  }

  async function bloquear(paciente) {
    await prisma.paciente.update({ where: { id: paciente.id }, data: { bloqueado: true, bloqueadoEl: new Date() } });
  }

  // Un paciente con datos en cada tabla que lo referencia.
  async function conTodo(paciente, fechaCita) {
    const cedula = { id: operador.id, permisos: ['paciente.read', 'consentimiento.write'] };
    await cita(paciente, fechaCita);
    await verificacion.verificarConCedula(paciente.id, cedula);
    const estado = (await consentimiento.estadoPorPaciente(paciente.id)).find((e) => e.finalidad.clave === 'encuestas');
    await consentimiento.otorgar({ pacienteId: paciente.id, finalidadClave: 'encuestas', textoId: estado.textoVigente.id, canal: 'presencial' }, cedula);
    await solicitudDePrueba(paciente, operador, { derecho: 'rectificacion', campo: 'nombre', valorPropuesto: 'Otro Nombre' }, { metodo: 'cedula' });
    await prisma.historialCambio.create({ data: { pacienteId: paciente.id, campo: 'nombre', valorAnteriorCifrado: null, cambiadoPorId: operador.id } });
    await prisma.solicitudDerecho.updateMany({ where: { pacienteId: paciente.id }, data: { estado: 'resuelta', resultado: 'atendida', resueltaEl: new Date() } });
  }

  beforeAll(async () => {
    process.env.SUPRESIONES_ARCHIVO = archivo;
    operador = await usuarioDePrueba('depuracion-operador@medibox.local', 'operador', password);
    const usuario = await usuarioDePrueba('depuracion-privacidad@medibox.local', 'privacidad', password);
    privacidad = usuario;

    const defecto = { contacto: '+56978000000' };
    for (const clave of ['vencida', 'sinCitas', 'anuladaReciente', 'reciente', 'activa', 'abierta', 'sinCitasNueva', 'restaurada']) {
      pacientes[clave] = await pacienteDePrueba({
        nombre: `Depuracion ${clave}`,
        ...defecto,
        createdAt: clave === 'sinCitas' ? haceAnios(16, ahora) : new Date(Date.now() - 72 * 60 * 60 * 1000),
      });
    }
    // Primero los datos (un paciente bloqueado sale del alcance del operador), después el bloqueo.
    await conTodo(pacientes.vencida, haceAnios(16, ahora));
    await cita(pacientes.anuladaReciente, haceAnios(16, ahora));
    await cita(pacientes.anuladaReciente, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), { anulada: true });
    await cita(pacientes.reciente, haceAnios(1, ahora));
    await cita(pacientes.activa, haceAnios(20, ahora));
    await cita(pacientes.abierta, haceAnios(16, ahora));
    await solicitudDePrueba(pacientes.abierta, operador, { derecho: 'acceso' });
    await cita(pacientes.restaurada, haceAnios(16, ahora));
    for (const clave of ['vencida', 'sinCitas', 'anuladaReciente', 'reciente', 'abierta', 'sinCitasNueva']) await bloquear(pacientes[clave]);
  });

  afterAll(async () => {
    process.env.SUPRESIONES_ARCHIVO = archivoAnterior;
    fs.rmSync(archivo, { force: true });
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('el plazo es de 15 años', () => {
    expect(ANIOS_FICHA).toBe(15);
  });

  it('candidatos: lo bloqueado cuya última atención cumplió los 15 años', async () => {
    const lista = (await candidatos(ahora)).filter((c) => Object.values(pacientes).some((p) => p.id === c.pacienteId));
    expect(lista.map((c) => c.pacienteId).sort((a, b) => a - b)).toEqual(ids('vencida', 'sinCitas', 'anuladaReciente').sort((a, b) => a - b));
    // Sin citas, el plazo cuenta desde el alta; una cita anulada no es una atención.
    expect(lista.find((c) => c.pacienteId === pacientes.sinCitas.id).ultimaAtencion).toBe(haceAnios(16, ahora).toISOString().slice(0, 10));
    expect(lista.find((c) => c.pacienteId === pacientes.anuladaReciente.id).ultimaAtencion).toBe(haceAnios(16, ahora).toISOString().slice(0, 10));
  });

  it('no son candidatos: lo que no está bloqueado, lo atendido hace poco ni lo que tiene una solicitud abierta', async () => {
    const lista = (await candidatos(ahora)).map((c) => c.pacienteId);
    for (const clave of ['activa', 'reciente', 'abierta', 'sinCitasNueva']) expect(lista).not.toContain(pacientes[clave].id);
  });

  it('listar candidatos no elimina nada', async () => {
    await candidatos(ahora);
    expect(await prisma.paciente.count({ where: { id: { in: ids('vencida', 'sinCitas', 'anuladaReciente') } } })).toBe(3);
  });

  it('solo la autoriza quien tiene el permiso de gestionar derechos, y existe', async () => {
    await expect(depurar({ ahora, autorizadoPorId: operador.id, soloIds: ids('vencida') })).rejects.toMatchObject({ statusCode: 403 });
    await expect(depurar({ ahora, autorizadoPorId: 99999999, soloIds: ids('vencida') })).rejects.toMatchObject({ statusCode: 403 });
    await expect(depurar({ ahora, soloIds: ids('vencida') })).rejects.toMatchObject({ statusCode: 403 });
    expect(await prisma.paciente.count({ where: { id: pacientes.vencida.id } })).toBe(1);
  });

  it('una cuenta suspendida no puede autorizarla', async () => {
    await prisma.usuario.update({ where: { id: privacidad.id }, data: { suspendida: true } });
    try {
      await expect(depurar({ ahora, autorizadoPorId: privacidad.id, soloIds: ids('vencida') })).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await prisma.usuario.update({ where: { id: privacidad.id }, data: { suspendida: false } });
    }
  });

  it('elimina al paciente y todo lo que lo referencia, y deja la auditoría', async () => {
    const antes = await dependientes(pacientes.vencida.id);
    expect(Object.values(antes).every((n) => n >= 1)).toBe(true);
    const auditoriaAntes = await prisma.auditLog.count({ where: { entidad: 'Paciente', entidadId: pacientes.vencida.id } });
    expect(auditoriaAntes).toBeGreaterThan(0);

    const resultado = await depurar({ ahora, autorizadoPorId: privacidad.id, soloIds: ids('vencida', 'sinCitas', 'anuladaReciente') });

    expect(resultado.eliminados).toBe(3);
    expect(resultado.pacientes.find((p) => p.pacienteId === pacientes.vencida.id)).toMatchObject({ citas: antes.citas, consentimientos: antes.consentimientos, solicitudes: antes.solicitudes, historial: antes.historial, verificaciones: antes.verificaciones });
    expect(await prisma.paciente.count({ where: { id: { in: ids('vencida', 'sinCitas', 'anuladaReciente') } } })).toBe(0);
    expect(await dependientes(pacientes.vencida.id)).toEqual({ citas: 0, consentimientos: 0, solicitudes: 0, historial: 0, verificaciones: 0 });
    // Lo demás sigue ahí.
    expect(await prisma.paciente.count({ where: { id: { in: ids('activa', 'reciente', 'abierta', 'sinCitasNueva') } } })).toBe(4);
    // La auditoría no se toca: solo guarda ids, y es la prueba de lo ocurrido.
    expect(await prisma.auditLog.count({ where: { entidad: 'Paciente', entidadId: pacientes.vencida.id } })).toBeGreaterThan(auditoriaAntes);
  });

  it('cada eliminación queda en la auditoría con quién la autorizó, y anotada para los respaldos', async () => {
    const fila = await prisma.auditLog.findFirst({ where: { accion: 'DEPURAR_PACIENTE', entidadId: pacientes.vencida.id } });
    expect(fila).toMatchObject({ usuarioId: privacidad.id, actor: 'sistema', entidad: 'Paciente', resultado: 'exito' });
    expect(fila.detalle).toEqual(expect.objectContaining({ citas: 1, consentimientos: 1 }));
    expect(lineas().filter((l) => l.tipo === 'depuracion').map((l) => l.pacienteId).sort((a, b) => a - b)).toEqual(ids('vencida', 'sinCitas', 'anuladaReciente').sort((a, b) => a - b));
    expect(lineas()[0]).toEqual({ tipo: 'depuracion', pacienteId: expect.any(Number), fecha: expect.any(String) });
  });

  it('correrlo de nuevo no encuentra nada', async () => {
    expect((await depurar({ ahora, autorizadoPorId: privacidad.id, soloIds: ids('vencida', 'sinCitas', 'anuladaReciente') })).eliminados).toBe(0);
  });

  it('solo toca los pacientes pedidos, aunque haya más candidatos', async () => {
    await bloquear(pacientes.restaurada);
    const otro = await depurar({ ahora, autorizadoPorId: privacidad.id, soloIds: [pacientes.restaurada.id + 1000000] });
    expect(otro.eliminados).toBe(0);
    expect(await prisma.paciente.count({ where: { id: pacientes.restaurada.id } })).toBe(1);
  });

  it('si se restaura un respaldo anterior, reaplicar vuelve a eliminarlo', async () => {
    // Lo que traería un respaldo previo a la depuración: el paciente otra vez ahí.
    await anotarRestriccion({ tipo: 'depuracion', pacienteId: pacientes.restaurada.id });

    expect(await reaplicar()).toEqual({ reaplicadas: 1 });
    expect(await prisma.paciente.count({ where: { id: pacientes.restaurada.id } })).toBe(0);
    expect(await dependientes(pacientes.restaurada.id)).toEqual({ citas: 0, consentimientos: 0, solicitudes: 0, historial: 0, verificaciones: 0 });
    expect(await prisma.auditLog.findFirst({ where: { accion: 'REAPLICAR_DEPURACION', entidadId: pacientes.restaurada.id } })).toMatchObject({ actor: 'sistema', usuarioId: null });
    expect(await reaplicar()).toEqual({ reaplicadas: 0 });
  });
});
