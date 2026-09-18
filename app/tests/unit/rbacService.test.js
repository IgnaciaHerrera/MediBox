const { obtenerPermisosPorRol } = require('../../src/services/rbacService');
const { prisma } = require('../../src/lib/prisma');

jest.mock('../../src/lib/prisma', () => ({
  prisma: { rolPermiso: { findMany: jest.fn() } },
}));

describe('rbacService.obtenerPermisosPorRol', () => {
  it('returns the list of permission keys for a role', async () => {
    prisma.rolPermiso.findMany.mockResolvedValue([
      { permiso: { clave: 'agenda.read' } },
      { permiso: { clave: 'box.read' } },
    ]);
    const permisos = await obtenerPermisosPorRol(3);
    expect(permisos).toEqual(['agenda.read', 'box.read']);
  });
});
