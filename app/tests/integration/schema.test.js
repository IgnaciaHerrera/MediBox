const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

describe('Prisma schema', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('can query every mapped table without error', async () => {
    const tablas = [
      prisma.usuario.findMany(),
      prisma.rol.findMany(),
      prisma.permiso.findMany(),
      prisma.especialidad.findMany(),
      prisma.medico.findMany(),
      prisma.pasillo.findMany(),
      prisma.box.findMany(),
      prisma.instrumento.findMany(),
      prisma.paciente.findMany(),
      prisma.cita.findMany(),
      prisma.auditLog.findMany(),
      prisma.notificacion.findMany(),
    ];

    const resultados = await Promise.all(tablas);
    resultados.forEach((resultado) => {
      expect(Array.isArray(resultado)).toBe(true);
    });
  });
});
