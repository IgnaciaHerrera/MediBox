const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { cifrarPaciente } = require('../../src/services/pacienteService');
const { descifrar } = require('../../src/lib/cifrado');

// El motivo de consulta vive en cada cita: se guarda cifrado, la API de citas
// no lo devuelve, el detalle lo muestra solo a quien puede leer al paciente y
// `npm run motivo:migrar` copia el motivo de legado del paciente a sus citas.
describe('Motivo de consulta en la cita', () => {
  const password = 'Password123!';
  let rolEscritura;
  let rolLectura;
  let escritura;
  let lectura;
  let especialidad;
  let medico;
  let pasillo;
  let box;
  const pacienteIds = [];

  function rutConDv(numero) {
    let suma = 0;
    let factor = 2;
    for (const d of String(numero).split('').reverse()) {
      suma += Number(d) * factor;
      factor = factor === 7 ? 2 : factor + 1;
    }
    const resto = 11 - (suma % 11);
    const dv = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
    return `${numero}-${dv}`;
  }

  async function crearRol(nombre, claves) {
    const rol = await prisma.rol.upsert({ where: { nombre }, update: {}, create: { nombre } });
    const permisos = await prisma.permiso.findMany({ where: { clave: { in: claves } } });
    await prisma.rolPermiso.deleteMany({ where: { rolId: rol.id } });
    await prisma.rolPermiso.createMany({ data: permisos.map((p) => ({ rolId: rol.id, permisoId: p.id })) });
    return rol;
  }

  async function crearUsuario(email, rol) {
    return prisma.usuario.upsert({
      where: { email },
      update: {},
      create: { nombre: email, email, passwordHash: await bcrypt.hash(password, 12), rolId: rol.id },
    });
  }

  async function crearPaciente(datosExtra = {}) {
    const paciente = await prisma.paciente.create({
      data: {
        ...cifrarPaciente({
          nombre: 'Paciente Motivo Test',
          rut: rutConDv(33000000 + Math.floor(Math.random() * 900000)),
          contacto: '+56900000002',
          ...datosExtra,
        }),
        fechaNacimiento: new Date('1990-01-01'),
      },
    });
    pacienteIds.push(paciente.id);
    return paciente;
  }

  beforeAll(async () => {
    rolEscritura = await crearRol('citas-motivo-escritura', ['agenda.read', 'agenda.write', 'paciente.read']);
    rolLectura = await crearRol('citas-motivo-lectura', ['agenda.read']);
    escritura = await crearUsuario('citas-motivo-escritura@medibox.local', rolEscritura);
    lectura = await crearUsuario('citas-motivo-lectura@medibox.local', rolLectura);

    especialidad = await prisma.especialidad.upsert({
      where: { nombre: 'Especialidad Motivo Test' },
      update: {},
      create: { nombre: 'Especialidad Motivo Test' },
    });
    medico = await prisma.medico.create({ data: { nombre: 'Dr. Motivo Test', especialidadId: especialidad.id } });
    pasillo = await prisma.pasillo.upsert({
      where: { nombre: 'Pasillo Motivo Test' },
      update: {},
      create: { nombre: 'Pasillo Motivo Test' },
    });
    box = await prisma.box.create({ data: { nombre: 'Box Motivo Test', pasilloId: pasillo.id } });
  });

  afterAll(async () => {
    await prisma.cita.deleteMany({ where: { pacienteId: { in: pacienteIds } } });
    await prisma.auditLog.deleteMany({ where: { usuarioId: { in: [escritura.id, lectura.id] } } });
    await prisma.paciente.deleteMany({ where: { id: { in: pacienteIds } } });
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.pasillo.delete({ where: { id: pasillo.id } });
    await prisma.medico.delete({ where: { id: medico.id } });
    await prisma.especialidad.delete({ where: { id: especialidad.id } });
    await prisma.usuario.deleteMany({ where: { id: { in: [escritura.id, lectura.id] } } });
    await prisma.rolPermiso.deleteMany({ where: { rolId: { in: [rolEscritura.id, rolLectura.id] } } });
    await prisma.rol.deleteMany({ where: { id: { in: [rolEscritura.id, rolLectura.id] } } });
    await prisma.$disconnect();
  });

  it('guarda el motivo cifrado en la cita y la API de citas no lo devuelve', async () => {
    const paciente = await crearPaciente();
    const { agent } = await loginAgent(app, { email: escritura.email, password });

    const sinMotivo = await agent.post('/api/citas').send({
      pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: '2033-01-10', horaInicio: '09:00', horaFin: '09:30',
    });
    expect(sinMotivo.status).toBe(400);

    const res = await agent.post('/api/citas').send({
      pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: '2033-01-10', horaInicio: '09:00', horaFin: '09:30',
      motivoConsulta: 'Dolor torácico al esfuerzo',
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('motivoConsultaCifrado');
    expect(res.body).not.toHaveProperty('motivoConsulta');

    const [fila] = await prisma.$queryRaw`SELECT motivo_consulta_cifrado FROM citas WHERE id = ${res.body.id}`;
    expect(fila.motivo_consulta_cifrado[0]).toBe(1); // versión del formato AES-256-GCM
    expect(fila.motivo_consulta_cifrado.toString('utf8')).not.toContain('Dolor torácico');
    expect(descifrar('cita.motivoConsulta', fila.motivo_consulta_cifrado)).toBe('Dolor torácico al esfuerzo');

    const lista = await agent.get('/api/citas').query({ fecha: '2033-01-10' });
    const enLista = lista.body.items.find((c) => c.id === res.body.id);
    expect(enLista).toBeDefined();
    expect(enLista).not.toHaveProperty('motivoConsultaCifrado');
  });

  it('el detalle muestra el motivo solo a quien puede leer al paciente', async () => {
    const paciente = await crearPaciente();
    const { agent } = await loginAgent(app, { email: escritura.email, password });
    const res = await agent.post('/api/citas').send({
      pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: '2033-02-10', horaInicio: '10:00', horaFin: '10:30',
      motivoConsulta: 'Revisión de lunar en espalda',
    });

    const conPermiso = await agent.get(`/agenda/${res.body.id}`);
    expect(conPermiso.status).toBe(200);
    expect(conPermiso.text).toContain('Revisión de lunar en espalda');

    const { agent: agenteLectura } = await loginAgent(app, { email: lectura.email, password });
    const sinPermiso = await agenteLectura.get(`/agenda/${res.body.id}`);
    expect(sinPermiso.status).toBe(200);
    expect(sinPermiso.text).not.toContain('Revisión de lunar en espalda');
  });

  it('npm run motivo:migrar copia el motivo de legado del paciente a sus citas sin motivo', async () => {
    const paciente = await crearPaciente({ motivoConsulta: 'Motivo de legado' });
    const cita = await prisma.cita.create({
      data: { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: new Date('2033-03-10'), horaInicio: '11:00', horaFin: '11:30' },
    });

    const script = path.join(__dirname, '../../prisma/migrar-motivo-citas.js');
    await promisify(execFile)('node', [script], { env: process.env });
    // Correrlo de nuevo no debe fallar ni cambiar nada (idempotente).
    await promisify(execFile)('node', [script], { env: process.env });

    const migrada = await prisma.cita.findUnique({ where: { id: cita.id }, select: { motivoConsultaCifrado: true } });
    expect(descifrar('cita.motivoConsulta', migrada.motivoConsultaCifrado)).toBe('Motivo de legado');
  });
});
