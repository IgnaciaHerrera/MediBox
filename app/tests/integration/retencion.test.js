const bcrypt = require('bcrypt');
const { prisma } = require('../../src/lib/prisma');
const { cifrarPaciente } = require('../../src/services/pacienteService');
const { cifrar } = require('../../src/lib/cifrado');
const { aplicarRetencion } = require('../../src/services/retencionService');

// Fechas relativas a hoy: la prueba aplica la política real, así que una
// fecha de referencia futura vaciaría también los datos de otras pruebas (o
// de la base de desarrollo, si la suite corre contra ella).
function haceMeses(meses) {
  const fecha = new Date();
  fecha.setMonth(fecha.getMonth() - meses);
  return fecha;
}

describe('Plazos de conservación', () => {
  let usuario;
  let especialidad;
  let medico;
  let pasillo;
  let box;
  const pacientes = {};

  async function paciente(clave, rut, creadoEl) {
    pacientes[clave] = await prisma.paciente.create({
      data: { ...cifrarPaciente({ nombre: `Retencion ${clave}`, rut, fechaNacimiento: '1970-01-01', contacto: '+56911110000' }), createdAt: creadoEl },
    });
  }

  beforeAll(async () => {
    const rol = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'medico' } });
    usuario = await prisma.usuario.upsert({
      where: { email: 'retencion-test@medibox.local' },
      update: {},
      create: { nombre: 'Retencion Test', email: 'retencion-test@medibox.local', passwordHash: await bcrypt.hash('x', 4), rolId: rol.id },
    });
    especialidad = await prisma.especialidad.create({ data: { nombre: 'Especialidad Retencion Test' } });
    medico = await prisma.medico.create({ data: { nombre: 'Dr. Retencion Test', especialidadId: especialidad.id } });
    pasillo = await prisma.pasillo.create({ data: { nombre: 'Pasillo Retencion Test' } });
    box = await prisma.box.create({ data: { nombre: 'Box Retencion Test', pasilloId: pasillo.id } });

    await paciente('inactivo', '30111222-K', haceMeses(48));
    await paciente('conCitaReciente', '30222333-5', haceMeses(48));
    await paciente('nuevo', '30333444-0', haceMeses(1));
    const cita = { medicoId: medico.id, boxId: box.id, horaInicio: '09:00', horaFin: '09:30' };
    await prisma.cita.create({ data: { ...cita, pacienteId: pacientes.inactivo.id, fecha: haceMeses(36) } });
    await prisma.cita.create({ data: { ...cita, pacienteId: pacientes.conCitaReciente.id, fecha: haceMeses(6) } });

    // Un contacto anterior del paciente inactivo, guardado en su historial.
    await prisma.historialCambio.create({
      data: { pacienteId: pacientes.inactivo.id, campo: 'contacto', valorAnteriorCifrado: cifrar('historial.contacto', '+56900000000'), cambiadoPorId: usuario.id, cambiadoEl: haceMeses(40) },
    });
    await prisma.notificacion.create({ data: { usuarioId: usuario.id, mensaje: 'vieja', createdAt: haceMeses(13) } });
    const codigo = { metodo: 'codigo_portal', codigoHash: Buffer.alloc(32, 1), sal: Buffer.alloc(16, 2), expiraEl: new Date() };
    await prisma.verificacionIdentidad.create({ data: { pacienteId: pacientes.nuevo.id, ...codigo, creadaEl: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });
    await prisma.verificacionIdentidad.create({ data: { pacienteId: pacientes.nuevo.id, ...codigo } });
    await prisma.notificacion.create({ data: { usuarioId: usuario.id, mensaje: 'reciente', createdAt: haceMeses(1) } });
  });

  afterAll(async () => {
    // Los usuarios de prueba (y sus roles) se conservan y se reutilizan con
    // upsert: tienen filas en la auditoría, que es de solo inserción.
    const ids = Object.values(pacientes).map((p) => p.id);
    await prisma.cita.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.historialCambio.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.verificacionIdentidad.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.paciente.deleteMany({ where: { id: { in: ids } } });
    await prisma.notificacion.deleteMany({ where: { usuarioId: usuario.id } });
    await prisma.medico.delete({ where: { id: medico.id } });
    await prisma.especialidad.delete({ where: { id: especialidad.id } });
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.pasillo.delete({ where: { id: pasillo.id } });
    await prisma.$disconnect();
  });

  it('elimina las notificaciones de más de un año y el contacto de quien lleva dos años sin citas', async () => {
    await aplicarRetencion();

    const mensajes = (await prisma.notificacion.findMany({ where: { usuarioId: usuario.id } })).map((n) => n.mensaje);
    expect(mensajes).toEqual(['reciente']);

    const contacto = async (clave) => (await prisma.paciente.findUnique({ where: { id: pacientes[clave].id } })).contactoCifrado;
    expect(await contacto('inactivo')).toBeNull();
    // Tampoco quedan sus contactos anteriores en el historial.
    expect(await prisma.historialCambio.count({ where: { pacienteId: pacientes.inactivo.id, valorAnteriorCifrado: { not: null } } })).toBe(0);
    // Con una cita en los últimos dos años, o recién registrado, se conserva.
    expect(await contacto('conCitaReciente')).not.toBeNull();
    expect(await contacto('nuevo')).not.toBeNull();

    // El hash de un código de hace más de un día se borra; el de hoy, no.
    const codigos = await prisma.verificacionIdentidad.findMany({ where: { pacienteId: pacientes.nuevo.id }, orderBy: { id: 'asc' } });
    expect(codigos.map((c) => c.codigoHash === null)).toEqual([true, false]);

    // El resto de la ficha no se toca: el registro clínico dura 15 años.
    expect(await prisma.paciente.count({ where: { id: pacientes.inactivo.id } })).toBe(1);

    // Idempotente: una segunda pasada no encuentra nada nuevo que borrar.
    const segunda = await aplicarRetencion();
    expect(segunda.notificacionesEliminadas).toBe(0);
  });

  it('deja RETENCION en la auditoría con actor sistema y los conteos en detalle', async () => {
    const antes = new Date();
    const resumen = await aplicarRetencion();
    const fila = await prisma.auditLog.findFirst({ where: { accion: 'RETENCION', timestamp: { gte: antes } }, orderBy: { id: 'desc' } });
    expect(fila).toMatchObject({ actor: 'sistema', usuarioId: null, entidad: 'Sistema', entidadId: 0 });
    expect(fila.detalle).toEqual(resumen);
  });
});
