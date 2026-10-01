// app/prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { cifrarPaciente } = require('../src/services/pacienteService');
const { descifrar } = require('../src/lib/cifrado');

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

const MEDICOS = [
  { nombre: 'Dra. Felipa Vázquez', especialidad: 'Cardiología' },
  { nombre: 'Dr. Matías Sandoval', especialidad: 'Cardiología' },
  { nombre: 'Dra. Ignacia Herrera', especialidad: 'Pediatría' },
  { nombre: 'Dra. Carla Soto', especialidad: 'Ginecología' },
  { nombre: 'Dr. Ignacio Fuentes', especialidad: 'Traumatología' },
  { nombre: 'Dra. Camila Barrera', especialidad: 'Dermatología' },
  { nombre: 'Dr. Alejandro Cortés', especialidad: 'Neurología' },
];

const PASILLOS = [
  { nombre: 'Pasillo A', boxes: ['Box 1', 'Box 2', 'Box 3'] },
  { nombre: 'Pasillo B', boxes: ['Box 4', 'Box 5'] },
];

const USUARIOS_DEMO = [
  { nombre: 'Carla Consulta', email: 'consulta@medibox.local', rol: 'consulta' },
  { nombre: 'Oscar Operador', email: 'operador@medibox.local', rol: 'operador' },
  { nombre: 'Dra. Felipa Vázquez', email: 'medico@medibox.local', rol: 'medico', medico: 'Dra. Felipa Vázquez' },
  { nombre: 'Gina Gestora', email: 'gestor@medibox.local', rol: 'gestor' },
];

const PASSWORD_DEMO = 'Demo1234!';

// Pacientes de ejemplo para que la agenda no se vea vacía en una instalación
// recién sembrada. El nombre se usa como clave de idempotencia.
const PACIENTES_DEMO = [
  { nombre: 'Ana Contreras', rut: '15234876-2', fechaNacimiento: '1987-04-12', contacto: '+56911112222', motivoConsulta: 'Control cardiológico de rutina' },
  { nombre: 'Pedro Muñoz', rut: '18456321-5', fechaNacimiento: '1993-11-02', contacto: '+56922223333', motivoConsulta: 'Dolor lumbar persistente' },
  { nombre: 'Javiera Rojas', rut: '20123456-5', fechaNacimiento: '2001-07-19', contacto: '+56933334444', motivoConsulta: 'Consulta pediátrica de control' },
];

// Las fechas se calculan relativas al momento en que se corre el seed (no
// hardcodeadas), para que la agenda siempre tenga datos visibles el día que
// se instale el proyecto, sin importar cuándo sea eso.
function fechaRelativaISO(diasDesdeHoy) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + diasDesdeHoy);
  return fecha.toISOString().slice(0, 10);
}

function citasDemo() {
  return [
    { pacienteNombre: 'Ana Contreras', medicoNombre: 'Dra. Felipa Vázquez', pasillo: 'Pasillo A', box: 'Box 1', diasDesdeHoy: 0, horaInicio: '09:00', horaFin: '09:30', estado: 'agendada' },
    { pacienteNombre: 'Pedro Muñoz', medicoNombre: 'Dr. Ignacio Fuentes', pasillo: 'Pasillo A', box: 'Box 2', diasDesdeHoy: 0, horaInicio: '11:00', horaFin: '11:30', estado: 'agendada' },
    { pacienteNombre: 'Javiera Rojas', medicoNombre: 'Dra. Ignacia Herrera', pasillo: 'Pasillo B', box: 'Box 4', diasDesdeHoy: -1, horaInicio: '15:00', horaFin: '15:30', estado: 'atendido' },
    { pacienteNombre: 'Ana Contreras', medicoNombre: 'Dra. Felipa Vázquez', pasillo: 'Pasillo A', box: 'Box 3', diasDesdeHoy: 2, horaInicio: '10:00', horaFin: '10:30', estado: 'agendada' },
  ];
}

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

async function seedMedicos() {
  for (const { nombre, especialidad } of MEDICOS) {
    const esp = await prisma.especialidad.findUniqueOrThrow({ where: { nombre: especialidad } });
    const existente = await prisma.medico.findFirst({ where: { nombre } });
    if (!existente) {
      await prisma.medico.create({ data: { nombre, especialidadId: esp.id } });
    }
  }
}

async function seedEspacios() {
  for (const { nombre: pasilloNombre, boxes } of PASILLOS) {
    const pasillo = await prisma.pasillo.upsert({
      where: { nombre: pasilloNombre },
      update: {},
      create: { nombre: pasilloNombre },
    });
    for (const boxNombre of boxes) {
      await prisma.box.upsert({
        where: { pasilloId_nombre: { pasilloId: pasillo.id, nombre: boxNombre } },
        update: {},
        create: { nombre: boxNombre, pasilloId: pasillo.id },
      });
    }
  }
}

async function seedUsuariosDemo() {
  const passwordHash = await bcrypt.hash(PASSWORD_DEMO, 12);
  for (const { nombre, email, rol, medico } of USUARIOS_DEMO) {
    const rolRow = await prisma.rol.findUniqueOrThrow({ where: { nombre: rol } });
    const usuario = await prisma.usuario.upsert({
      where: { email },
      update: {},
      create: { nombre, email, passwordHash, rolId: rolRow.id },
    });

    if (medico) {
      const medicoRow = await prisma.medico.findFirst({ where: { nombre: medico } });
      if (medicoRow && !medicoRow.usuarioId) {
        await prisma.medico.update({ where: { id: medicoRow.id }, data: { usuarioId: usuario.id } });
      }
    }
  }
}

// El nombre vive cifrado, así que se descifra en memoria para comparar. No
// se usa el índice del RUT como clave: las bases sembradas antes de validar
// el dígito verificador tienen otros RUT de ejemplo y se duplicarían.
async function idsPacientesPorNombre() {
  const filas = await prisma.paciente.findMany({ select: { id: true, nombreCifrado: true } });
  return new Map(filas.map((f) => [descifrar('paciente.nombre', f.nombreCifrado), f.id]));
}

async function seedPacientes() {
  const existentes = await idsPacientesPorNombre();
  for (const paciente of PACIENTES_DEMO) {
    if (!existentes.has(paciente.nombre)) {
      await prisma.paciente.create({
        data: { ...cifrarPaciente(paciente), fechaNacimiento: new Date(paciente.fechaNacimiento) },
      });
    }
  }
}

async function seedCitas() {
  const pacientes = await idsPacientesPorNombre();
  for (const c of citasDemo()) {
    const medico = await prisma.medico.findFirstOrThrow({ where: { nombre: c.medicoNombre } });
    const box = await prisma.box.findFirstOrThrow({ where: { nombre: c.box, pasillo: { nombre: c.pasillo } } });
    const fecha = fechaRelativaISO(c.diasDesdeHoy);

    const existente = await prisma.cita.findFirst({
      where: { medicoId: medico.id, boxId: box.id, fecha: new Date(fecha), horaInicio: c.horaInicio },
    });
    if (!existente) {
      await prisma.cita.create({
        data: {
          pacienteId: pacientes.get(c.pacienteNombre),
          medicoId: medico.id,
          boxId: box.id,
          fecha: new Date(fecha),
          horaInicio: c.horaInicio,
          horaFin: c.horaFin,
          estado: c.estado,
        },
      });
    }
  }
}

async function main() {
  await seedPermisos();
  await seedRoles();
  await seedEspecialidades();
  await seedAdminUser();
  await seedMedicos();
  await seedEspacios();
  await seedUsuariosDemo();
  await seedPacientes();
  await seedCitas();
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
