const { Prisma } = require('@prisma/client');
const { verificarConflicto, crearCita } = require('../../src/services/citaService');
const { prisma } = require('../../src/lib/prisma');

jest.mock('../../src/lib/prisma', () => ({
  prisma: { cita: { findFirst: jest.fn() }, $transaction: jest.fn(), auditLog: { create: jest.fn() } },
}));

function fallaSerializacion() {
  return new Prisma.PrismaClientKnownRequestError('could not serialize access due to read/write dependencies', {
    code: 'P2034',
    clientVersion: 'test',
  });
}

describe('citaService.verificarConflicto', () => {
  it('returns true when an overlapping non-annulled cita exists for the same box', async () => {
    prisma.cita.findFirst.mockResolvedValue({ id: 5 });
    const hayConflicto = await verificarConflicto({ boxId: 1, medicoId: 2, fecha: '2026-10-01', horaInicio: '10:00', horaFin: '11:00' });
    expect(hayConflicto).toBe(true);
  });

  it('returns false when no overlapping cita exists', async () => {
    prisma.cita.findFirst.mockResolvedValue(null);
    const hayConflicto = await verificarConflicto({ boxId: 1, medicoId: 2, fecha: '2026-10-01', horaInicio: '10:00', horaFin: '11:00' });
    expect(hayConflicto).toBe(false);
  });
});

describe('citaService.crearCita — transacción Serializable y reintento', () => {
  const datos = { pacienteId: 1, medicoId: 2, boxId: 3, fecha: '2026-10-01', horaInicio: '10:00', horaFin: '11:00', motivoConsulta: 'Control' };

  beforeEach(() => {
    prisma.$transaction.mockReset();
    prisma.auditLog.create.mockReset();
  });

  it('registers the audit row through the transaction client (tx), not the global prisma client, so it rolls back with the insert on abort', async () => {
    const txAuditCreate = jest.fn().mockResolvedValue({ id: 999 });
    const tx = {
      cita: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 42 }),
      },
      auditLog: { create: txAuditCreate },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const resultado = await crearCita(datos, 99);

    expect(resultado).toEqual({ id: 42 });
    expect(txAuditCreate).toHaveBeenCalledWith({
      data: { usuarioId: 99, accion: 'CREATE', entidad: 'Cita', entidadId: 42 },
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('invokes $transaction with isolationLevel Serializable', async () => {
    prisma.$transaction.mockResolvedValue({ id: 1 });
    await crearCita(datos, 99);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });

  it('retries the whole transaction on a Postgres serialization failure (P2034) and succeeds', async () => {
    prisma.$transaction
      .mockRejectedValueOnce(fallaSerializacion())
      .mockResolvedValueOnce({ id: 42 });

    const resultado = await crearCita(datos, 99);

    expect(resultado).toEqual({ id: 42 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up and propagates the error after exhausting retries on repeated P2034', async () => {
    prisma.$transaction.mockRejectedValue(fallaSerializacion());

    await expect(crearCita(datos, 99)).rejects.toThrow();
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry on a non-serialization error (e.g. conflict AppError) and propagates it immediately', async () => {
    const conflictoError = new Error('Conflicto de horario para el box o el médico seleccionado');
    conflictoError.statusCode = 409;
    prisma.$transaction.mockRejectedValue(conflictoError);

    await expect(crearCita(datos, 99)).rejects.toThrow('Conflicto de horario');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
