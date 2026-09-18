// app/prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const PERMISOS = [
  'dashboard.read', 'dashboard.write',
  'agenda.read', 'agenda.write',
  'box.read', 'box.write', 'box.detalle.read', 'box.detalle.write',
  'medicos.read',
  'paciente.read', 'paciente.write',
  'notificaciones.read',
  'auditoria.read',
  'data.import', 'data.export',
  'admin.users', 'admin.roles', 'admin.system',
];

const ROLES = {
  consulta: ['dashboard.read', 'agenda.read', 'box.read', 'box.detalle.read', 'medicos.read', 'notificaciones.read'],
  operador: ['dashboard.read', 'agenda.read', 'agenda.write', 'box.read', 'box.write', 'box.detalle.read', 'medicos.read', 'paciente.read', 'paciente.write', 'notificaciones.read'],
  medico: ['dashboard.read', 'agenda.read', 'medicos.read', 'paciente.read', 'notificaciones.read'],
  gestor: ['dashboard.read', 'dashboard.write', 'agenda.read', 'agenda.write', 'box.read', 'box.write', 'box.detalle.read', 'box.detalle.write', 'medicos.read', 'paciente.read', 'notificaciones.read', 'auditoria.read', 'data.import', 'data.export'],
  admin: PERMISOS,
};

const ESPECIALIDADES = ['Cardiología', 'Pediatría', 'Ginecología', 'Traumatología', 'Dermatología', 'Neurología'];

async function seedPermisos() {
  for (const clave of PERMISOS) {
    await prisma.permiso.upsert({ where: { clave }, update: {}, create: { clave } });
  }
}

async function seedRoles() {
  for (const [nombre, claves] of Object.entries(ROLES)) {
    const rol = await prisma.rol.upsert({ where: { nombre }, update: {}, create: { nombre } });
    const permisos = await prisma.permiso.findMany({ where: { clave: { in: claves } } });
    for (const permiso of permisos) {
      await prisma.rolPermiso.upsert({
        where: { rolId_permisoId: { rolId: rol.id, permisoId: permiso.id } },
        update: {},
        create: { rolId: rol.id, permisoId: permiso.id },
      });
    }
  }
}

async function seedEspecialidades() {
  for (const nombre of ESPECIALIDADES) {
    await prisma.especialidad.upsert({ where: { nombre }, update: {}, create: { nombre } });
  }
}

async function seedAdminUser() {
  const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
  const passwordHash = await bcrypt.hash('Admin123!', 12);
  await prisma.usuario.upsert({
    where: { email: 'admin@medibox.local' },
    update: {},
    create: {
      nombre: 'Administrador MediBox',
      email: 'admin@medibox.local',
      passwordHash,
      rolId: rolAdmin.id,
    },
  });
}

async function main() {
  await seedPermisos();
  await seedRoles();
  await seedEspecialidades();
  await seedAdminUser();
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
