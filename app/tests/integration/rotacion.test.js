const crypto = require('crypto');
const { prisma } = require('../../src/lib/prisma');
const { pacienteDePrueba } = require('../helpers/datos');
const { descifrarCon, hmacCon, descifrar } = require('../../src/lib/cifrado');
const { normalizarRut } = require('../../src/lib/rut');
const { rotar } = require('../../src/services/rotacionService');

// Rotación de llaves (Hito 3, respuesta a incidentes): si una llave se filtra,
// se recifra todo con una nueva. Para no tocar la base de pruebas compartida,
// cada rotación corre dentro de una transacción que el test revierte.
describe('Rotación de llaves', () => {
  const REVERTIR = 'revertir la rotación de prueba';
  let paciente;

  const llaveDe = (variable) => Buffer.from(process.env[variable], 'base64');

  async function dentroDeTransaccionRevertida(prueba) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await prueba(tx);
          throw new Error(REVERTIR);
        },
        { timeout: 120000 },
      ),
    ).rejects.toThrow(REVERTIR);
  }

  beforeAll(async () => {
    paciente = await pacienteDePrueba({ nombre: 'Paciente Rotacion', contacto: '+56978000001' });
  });

  afterAll(async () => {
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.$disconnect();
  });

  it('tras rotar la llave de identidad, los pacientes se descifran con la nueva y no con la vieja', async () => {
    const vieja = llaveDe('PACIENTE_IDENTIDAD_KEY');
    const nueva = crypto.randomBytes(32);
    await dentroDeTransaccionRevertida(async (tx) => {
      const { filas } = await rotar('PACIENTE_IDENTIDAD_KEY', { llaveAnterior: vieja, llaveNueva: nueva }, tx);
      expect(filas).toBeGreaterThan(0);
      const fila = await tx.paciente.findUnique({ where: { id: paciente.id } });
      expect(descifrarCon(nueva, 'paciente.nombre', fila.nombreCifrado)).toBe('Paciente Rotacion');
      expect(() => descifrarCon(vieja, 'paciente.nombre', fila.nombreCifrado)).toThrow();
      // El contacto tiene su propia llave: no se toca.
      expect(descifrar('paciente.contacto', fila.contactoCifrado)).toBe('+56978000001');
    });
    // Revertida: la base sigue con la llave del entorno.
    const fila = await prisma.paciente.findUnique({ where: { id: paciente.id } });
    expect(descifrar('paciente.nombre', fila.nombreCifrado)).toBe('Paciente Rotacion');
  });

  it('rotar la llave del índice del RUT recalcula el índice, así que la búsqueda por RUT sigue funcionando', async () => {
    const nueva = crypto.randomBytes(32);
    await dentroDeTransaccionRevertida(async (tx) => {
      await rotar('PACIENTE_RUT_HMAC_KEY', { llaveAnterior: llaveDe('PACIENTE_RUT_HMAC_KEY'), llaveNueva: nueva }, tx);
      const fila = await tx.paciente.findUnique({ where: { id: paciente.id } });
      const rut = normalizarRut(descifrar('paciente.rut', fila.rutCifrado));
      expect(fila.rutIndice.equals(hmacCon(nueva, rut))).toBe(true);
    });
  });

  it('con una llave anterior equivocada falla sin dejar nada a medias', async () => {
    await expect(rotar('PACIENTE_IDENTIDAD_KEY', { llaveAnterior: crypto.randomBytes(32), llaveNueva: crypto.randomBytes(32) })).rejects.toThrow();
    const fila = await prisma.paciente.findUnique({ where: { id: paciente.id } });
    expect(descifrar('paciente.nombre', fila.nombreCifrado)).toBe('Paciente Rotacion');
  });

  it('rechaza llaves iguales y variables que no guardan datos rotables', async () => {
    const llave = crypto.randomBytes(32);
    await expect(rotar('PACIENTE_IDENTIDAD_KEY', { llaveAnterior: llave, llaveNueva: llave })).rejects.toThrow(/distintas/);
    await expect(rotar('PACIENTE_SEUDONIMO_KEY', { llaveAnterior: llave, llaveNueva: crypto.randomBytes(32) })).rejects.toThrow(/no guarda/);
  });
});
