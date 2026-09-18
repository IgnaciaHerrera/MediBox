const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

describe('seed script', () => {
  beforeAll(() => {
    execSync('node prisma/seed.js', { stdio: 'inherit' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates the admin role with every permission', async () => {
    const admin = await prisma.rol.findUnique({
      where: { nombre: 'admin' },
      include: { permisos: true },
    });
    expect(admin.permisos.length).toBeGreaterThanOrEqual(18);
  });

  it('creates the admin user with a hashed password', async () => {
    const usuario = await prisma.usuario.findUnique({ where: { email: 'admin@medibox.local' } });
    expect(usuario).not.toBeNull();
    expect(usuario.passwordHash).not.toBe('Admin123!');
  });

  it('does not grant paciente.read to the consulta role', async () => {
    const consulta = await prisma.rol.findUnique({
      where: { nombre: 'consulta' },
      include: { permisos: { include: { permiso: true } } },
    });
    const claves = consulta.permisos.map((rp) => rp.permiso.clave);
    expect(claves).not.toContain('paciente.read');
    expect(claves).toContain('agenda.read');
  });
});
