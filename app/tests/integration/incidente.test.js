const crypto = require('crypto');
const { prisma } = require('../../src/lib/prisma');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { limpiarPacientes } = require('../helpers/derechos');
const { estimarAlcance } = require('../../src/services/incidenteService');

// Alcance de un incidente (Hito 3): a partir de la auditoría, cuántos
// titulares y qué categorías de datos tocó un acceso indebido en una
// ventana. Es lo que pide la notificación a la Agencia y a los titulares.
describe('Alcance de un incidente', () => {
  const password = 'Password123!';
  const dia = new Date(Date.UTC(2001, 0, 1) + crypto.randomInt(18000) * 24 * 60 * 60 * 1000);
  const enUtc = (horas) => new Date(dia.getTime() + horas * 60 * 60 * 1000);
  const ventana = { desde: dia, hasta: enUtc(24) };
  let atacante;
  let otro;
  let adulto;
  let menor;

  beforeAll(async () => {
    atacante = await usuarioDePrueba('incidente-atacante@medibox.local', 'operador', password);
    otro = await usuarioDePrueba('incidente-otro@medibox.local', 'operador', password);
    adulto = await pacienteDePrueba({ nombre: 'Incidente Adulto', fechaNacimiento: '1970-01-01' });
    // Menor a la fecha del incidente: la edad se calcula a esa fecha, no a la de hoy.
    const nacimiento = new Date(dia);
    nacimiento.setUTCFullYear(nacimiento.getUTCFullYear() - 10);
    menor = await pacienteDePrueba({ nombre: 'Incidente Menor', fechaNacimiento: nacimiento.toISOString().slice(0, 10) });

    const fila = (datos) => prisma.auditLog.create({ data: { entidad: 'Paciente', timestamp: enUtc(3), ...datos } });
    await fila({ usuarioId: atacante.id, accion: 'READ', entidadId: adulto.id });
    await fila({ usuarioId: atacante.id, accion: 'READ', entidadId: menor.id, detalle: { motivo: 'verificacion' } });
    await fila({ usuarioId: atacante.id, accion: 'EXPORT', entidadId: 0 });
    await fila({ usuarioId: otro.id, accion: 'LIST', entidadId: 0 });
    await fila({ usuarioId: otro.id, accion: 'READ', entidadId: menor.id, resultado: 'denegado' });
  });

  afterAll(async () => {
    await limpiarPacientes([adulto.id, menor.id]);
    await prisma.$disconnect();
  });

  it('cuenta los titulares distintos, sus categorías, los menores y las acciones de la ventana', async () => {
    const alcance = await estimarAlcance(ventana);
    expect(alcance.titulares).toBe(2);
    // La ficha muestra identidad, contacto y citas con motivo; la lectura para
    // verificar la identidad, solo el contacto.
    expect(alcance.porCategoria).toEqual({ identidad: 1, contacto: 2, salud: 1 });
    expect(alcance.menores).toBe(1);
    expect(alcance.acciones).toMatchObject({ READ: 2, EXPORT: 1, LIST: 1 });
    expect(alcance.exportacionesSeudonimizadas).toBe(1);
    expect(alcance.listados).toBe(1);
  });

  it('un acceso negado no cuenta como dato expuesto', async () => {
    const alcance = await estimarAlcance({ ...ventana, usuarioId: otro.id });
    expect(alcance.titulares).toBe(0);
    expect(alcance.listados).toBe(1);
  });

  it('filtra por usuario', async () => {
    const alcance = await estimarAlcance({ ...ventana, usuarioId: atacante.id });
    expect(alcance.titulares).toBe(2);
    expect(alcance.listados).toBe(0);
  });

  it('solo entrega los ids de los titulares si se piden', async () => {
    expect((await estimarAlcance(ventana)).ids).toBeUndefined();
    expect((await estimarAlcance({ ...ventana, conIds: true })).ids.sort()).toEqual([adulto.id, menor.id].sort());
  });
});
