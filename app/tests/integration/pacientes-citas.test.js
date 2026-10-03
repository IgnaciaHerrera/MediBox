const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { cifrarPaciente } = require('../../src/services/pacienteService');

// Citas del paciente en su ficha (/pacientes/:id): próximas e historial, y
// solo para quien puede ver la agenda.
describe('Citas en la ficha del paciente', () => {
  const password = 'Password123!';
  let rolConAgenda;
  let rolSinAgenda;
  let conAgenda;
  let sinAgenda;
  let especialidad;
  let medico;
  let pasillo;
  let box;
  let paciente;

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

  beforeAll(async () => {
    rolConAgenda = await crearRol('pacientes-citas-con-agenda', ['paciente.read', 'agenda.read']);
    rolSinAgenda = await crearRol('pacientes-citas-sin-agenda', ['paciente.read']);
    conAgenda = await crearUsuario('pacientes-citas-con@medibox.local', rolConAgenda);
    sinAgenda = await crearUsuario('pacientes-citas-sin@medibox.local', rolSinAgenda);

    especialidad = await prisma.especialidad.upsert({
      where: { nombre: 'Especialidad Citas Paciente Test' },
      update: {},
      create: { nombre: 'Especialidad Citas Paciente Test' },
    });
    medico = await prisma.medico.create({ data: { nombre: 'Dr. Citas Paciente Test', especialidadId: especialidad.id } });
    pasillo = await prisma.pasillo.upsert({
      where: { nombre: 'Pasillo Citas Paciente Test' },
      update: {},
      create: { nombre: 'Pasillo Citas Paciente Test' },
    });
    box = await prisma.box.create({ data: { nombre: 'Box Citas Paciente Test', pasilloId: pasillo.id } });
    paciente = await prisma.paciente.create({
      data: {
        ...cifrarPaciente({
          nombre: 'Paciente Citas Test',
          rut: rutConDv(32000000 + Math.floor(Math.random() * 900000)),
          contacto: '+56900000001',
          motivoConsulta: 'Prueba de citas en la ficha',
        }),
        fechaNacimiento: new Date('1990-01-01'),
      },
    });

    const base = { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id };
    await prisma.cita.createMany({
      data: [
        { ...base, fecha: new Date('2032-03-10'), horaInicio: '09:00', horaFin: '09:30', estado: 'agendada' },
        { ...base, fecha: new Date('2020-03-10'), horaInicio: '10:00', horaFin: '10:30', estado: 'atendido' },
        { ...base, fecha: new Date('2032-04-10'), horaInicio: '11:00', horaFin: '11:30', estado: 'agendada', anulada: true },
      ],
    });
  });

  afterAll(async () => {
    await prisma.cita.deleteMany({ where: { pacienteId: paciente.id } });
    await prisma.auditLog.deleteMany({ where: { usuarioId: { in: [conAgenda.id, sinAgenda.id] } } });
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.pasillo.delete({ where: { id: pasillo.id } });
    await prisma.medico.delete({ where: { id: medico.id } });
    await prisma.especialidad.delete({ where: { id: especialidad.id } });
    await prisma.usuario.deleteMany({ where: { id: { in: [conAgenda.id, sinAgenda.id] } } });
    await prisma.rolPermiso.deleteMany({ where: { rolId: { in: [rolConAgenda.id, rolSinAgenda.id] } } });
    await prisma.rol.deleteMany({ where: { id: { in: [rolConAgenda.id, rolSinAgenda.id] } } });
    await prisma.$disconnect();
  });

  it('separa las próximas del historial, y la anulada va al historial', async () => {
    const { agent } = await loginAgent(app, { email: conAgenda.email, password });
    const res = await agent.get(`/pacientes/${paciente.id}`);
    expect(res.status).toBe(200);

    const proximas = res.text.slice(res.text.indexOf('>Próximas<'), res.text.indexOf('>Historial<'));
    const historial = res.text.slice(res.text.indexOf('>Historial<'));
    expect(proximas).toContain('10-03-2032');
    expect(proximas).not.toContain('10-04-2032');
    expect(historial).toContain('10-03-2020');
    expect(historial).toContain('10-04-2032');
    expect(historial).toContain('badge-anulada');
  });

  it('pagina el historial de a 10 citas', async () => {
    // 11 citas pasadas más: el historial queda con 13 (2 páginas).
    await prisma.cita.createMany({
      data: Array.from({ length: 11 }, (_, i) => ({
        pacienteId: paciente.id,
        medicoId: medico.id,
        boxId: box.id,
        fecha: new Date(`2019-01-${String(i + 10).padStart(2, '0')}`),
        horaInicio: '08:00',
        horaFin: '08:30',
        estado: 'atendido',
      })),
    });
    const { agent } = await loginAgent(app, { email: conAgenda.email, password });

    const primera = await agent.get(`/pacientes/${paciente.id}`);
    expect(primera.text).toContain('página 1 de 2');
    expect(primera.text).toContain('Siguiente →');
    expect(primera.text).not.toContain('10-01-2019');

    const segunda = await agent.get(`/pacientes/${paciente.id}?page=2`);
    expect(segunda.text).toContain('página 2 de 2');
    expect(segunda.text).toContain('← Anterior');
    expect(segunda.text).toContain('10-01-2019');
    // Las próximas se muestran completas en todas las páginas.
    expect(segunda.text).toContain('10-03-2032');

    // Una página fuera de rango muestra la última.
    const fuera = await agent.get(`/pacientes/${paciente.id}?page=99`);
    expect(fuera.text).toContain('página 2 de 2');
  });

  it('no muestra las citas a quien no puede ver la agenda', async () => {
    const { agent } = await loginAgent(app, { email: sinAgenda.email, password });
    const res = await agent.get(`/pacientes/${paciente.id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('paciente-citas-titulo');
  });
});
