const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

describe('seed script', () => {
  beforeAll(() => {
    // El entorno del sandbox de Jest (con las llaves que carga setup-env.js
    // desde .env) no se hereda solo: execSync usa el del proceso real.
    execSync('node prisma/seed.js', { stdio: 'inherit', env: process.env });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('separates duties: admin manages accounts and roles but cannot read patients or the audit log', async () => {
    const admin = await prisma.rol.findUnique({
      where: { nombre: 'admin' },
      include: { permisos: { include: { permiso: true } } },
    });
    const claves = admin.permisos.map((rp) => rp.permiso.clave);
    expect(claves).toEqual(expect.arrayContaining(['admin.users', 'admin.roles', 'admin.system']));
    claves.forEach((clave) => expect(clave).not.toMatch(/^(paciente|auditoria|data)\./));
  });

  it('limits the medico role to its own patients and its own citas', async () => {
    const medico = await prisma.rol.findUnique({
      where: { nombre: 'medico' },
      include: { permisos: { include: { permiso: true } } },
    });
    const claves = medico.permisos.map((rp) => rp.permiso.clave);
    expect(claves).toEqual(expect.arrayContaining(['paciente.read.propios', 'agenda.estado.propias']));
    expect(claves).not.toContain('paciente.read');
    expect(claves).not.toContain('agenda.write');
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
