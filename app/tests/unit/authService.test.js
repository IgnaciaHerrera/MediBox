// app/tests/unit/authService.test.js
const bcrypt = require('bcrypt');
const { hashPassword, verifyPassword, autenticar } = require('../../src/services/authService');
const { prisma } = require('../../src/lib/prisma');

jest.mock('../../src/lib/prisma', () => ({
  prisma: { usuario: { findUnique: jest.fn() } },
}));

describe('authService', () => {
  it('hashPassword produces a bcrypt hash verifiable with the same password', async () => {
    const hash = await hashPassword('Secreto123!');
    expect(hash).not.toBe('Secreto123!');
    await expect(bcrypt.compare('Secreto123!', hash)).resolves.toBe(true);
  });

  it('verifyPassword returns true for a matching password', async () => {
    const hash = await bcrypt.hash('Secreto123!', 12);
    await expect(verifyPassword('Secreto123!', hash)).resolves.toBe(true);
  });

  it('verifyPassword returns false for a non-matching password', async () => {
    const hash = await bcrypt.hash('Secreto123!', 12);
    await expect(verifyPassword('otra-cosa', hash)).resolves.toBe(false);
  });

  it('autenticar returns null when the user does not exist', async () => {
    prisma.usuario.findUnique.mockResolvedValue(null);
    await expect(autenticar('nadie@medibox.local', 'x')).resolves.toBeNull();
  });

  it('autenticar returns the user without passwordHash on a match', async () => {
    const passwordHash = await bcrypt.hash('Secreto123!', 12);
    prisma.usuario.findUnique.mockResolvedValue({
      id: 1, nombre: 'Ana', email: 'ana@medibox.local', passwordHash, rolId: 2,
    });
    const usuario = await autenticar('ana@medibox.local', 'Secreto123!');
    expect(usuario).toEqual({ id: 1, nombre: 'Ana', email: 'ana@medibox.local', rolId: 2 });
  });

  it('autenticar returns null on a wrong password', async () => {
    const passwordHash = await bcrypt.hash('Secreto123!', 12);
    prisma.usuario.findUnique.mockResolvedValue({
      id: 1, nombre: 'Ana', email: 'ana@medibox.local', passwordHash, rolId: 2,
    });
    await expect(autenticar('ana@medibox.local', 'incorrecta')).resolves.toBeNull();
  });
});
