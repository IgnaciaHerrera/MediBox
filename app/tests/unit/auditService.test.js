const { registrar, listar } = require('../../src/services/auditService');
const { prisma } = require('../../src/lib/prisma');

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

describe('auditService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registrar writes a row with the given fields', async () => {
    prisma.auditLog.create.mockResolvedValue({});
    await registrar({ usuarioId: 1, accion: 'READ', entidad: 'Paciente', entidadId: 42 });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: { usuarioId: 1, accion: 'READ', entidad: 'Paciente', entidadId: 42 },
    });
  });

  it('listar paginates and returns total count', async () => {
    prisma.auditLog.findMany.mockResolvedValue([{ id: 1 }]);
    prisma.auditLog.count.mockResolvedValue(1);
    const result = await listar({ page: 1, pageSize: 20 });
    expect(result).toEqual({ items: [{ id: 1 }], total: 1, page: 1, pageSize: 20 });
  });
});
