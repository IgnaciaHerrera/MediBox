const fs = require('fs');
const os = require('os');
const path = require('path');
const { prisma } = require('../../src/lib/prisma');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const { cifrar } = require('../../src/lib/cifrado');
const derechos = require('../../src/services/derechosService');
const { reaplicar } = require('../../src/services/supresionService');

// Los respaldos no se editan: rotan a los 30 días. Para que restaurar uno
// no resucite lo que el titular pidió suprimir, cada supresión queda en un
// archivo fuera de la base (y de sus respaldos) que se reaplica al restaurar.
describe('Supresiones que sobreviven a una restauración', () => {
  const password = 'Password123!';
  const archivo = path.join(os.tmpdir(), `medibox-supresiones-${process.pid}-${Date.now()}.jsonl`);
  const archivoAnterior = process.env.SUPRESIONES_ARCHIVO;
  let paciente;
  let privacidad;

  beforeAll(async () => {
    process.env.SUPRESIONES_ARCHIVO = archivo;
    const operador = await usuarioDePrueba('supresiones-operador@medibox.local', 'operador', password);
    const usuario = await usuarioDePrueba('supresiones-privacidad@medibox.local', 'privacidad', password);
    privacidad = { id: usuario.id, permisos: ['derechos.registrar', 'derechos.gestionar'] };
    paciente = await pacienteDePrueba({ nombre: 'Paciente Suprimido', contacto: '+56977000001' });
    const solicitud = await solicitudDePrueba(paciente, operador, { derecho: 'supresion' }, { metodo: 'cedula' });
    await derechos.ejecutar(solicitud.id, privacidad, { respuesta: 'Suprimido; lo clínico queda bloqueado.' });
  });

  afterAll(async () => {
    process.env.SUPRESIONES_ARCHIVO = archivoAnterior;
    fs.rmSync(archivo, { force: true });
    await limpiarPacientes([paciente.id]);
    await prisma.$disconnect();
  });

  it('ejecutar una supresión agrega al archivo una línea con solo el id y la fecha', () => {
    const lineas = fs.readFileSync(archivo, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lineas).toEqual([{ pacienteId: paciente.id, fecha: expect.any(String), solicitudId: expect.any(Number) }]);
  });

  it('reaplicar vuelve a suprimir a un paciente "restaurado" desde un respaldo anterior', async () => {
    // Lo que traería un respaldo previo a la supresión.
    await prisma.paciente.update({ where: { id: paciente.id }, data: { contactoCifrado: cifrar('paciente.contacto', '+56977000001'), bloqueado: false } });

    expect(await reaplicar()).toEqual({ reaplicadas: 1 });
    const fila = await prisma.paciente.findUnique({ where: { id: paciente.id } });
    expect(fila.contactoCifrado).toBeNull();
    expect(fila.bloqueado).toBe(true);
    const fila2 = await prisma.auditLog.findFirst({ where: { accion: 'REAPLICAR_SUPRESION', entidadId: paciente.id }, orderBy: { id: 'desc' } });
    expect(fila2).toMatchObject({ actor: 'sistema', usuarioId: null });
  });

  it('correrlo de nuevo no cambia nada', async () => {
    expect(await reaplicar()).toEqual({ reaplicadas: 0 });
  });

  it('sin archivo no hace nada', async () => {
    process.env.SUPRESIONES_ARCHIVO = `${archivo}.no-existe`;
    expect(await reaplicar()).toEqual({ reaplicadas: 0 });
    process.env.SUPRESIONES_ARCHIVO = archivo;
  });
});
