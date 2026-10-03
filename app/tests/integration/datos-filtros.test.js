const crypto = require('crypto');
const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');

// Filtros opcionales de la exportación (rango de fechas, estado de la cita y
// acción de auditoría). Los datos propios usan fechas de 2031 para no
// mezclarse con los del resto de las pruebas ni con los del seed.
describe('Filtros de la exportación de datos', () => {
  const password = 'Password123!';
  let usuario;
  let especialidad;
  let medico;
  let pasillo;
  let box;
  let paciente;

  function filasDe(csv) {
    return csv.trim().split('\r\n').slice(1).map((linea) => linea.split(','));
  }

  // Columnas del CSV de citas: id, pacienteId, medico, pasillo, box, fecha, ...
  function fechasPropias(csv) {
    return filasDe(csv)
      .filter((f) => Number(f[1]) === paciente.id)
      .map((f) => f[5])
      .sort();
  }

  beforeAll(async () => {
    const rolAdmin = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'admin' } });
    usuario = await prisma.usuario.upsert({
      where: { email: 'datos-filtros-test@medibox.local' },
      update: {},
      create: {
        nombre: 'Filtros Datos Test',
        email: 'datos-filtros-test@medibox.local',
        passwordHash: await bcrypt.hash(password, 12),
        rolId: rolAdmin.id,
      },
    });

    especialidad = await prisma.especialidad.upsert({
      where: { nombre: 'Especialidad Filtros Test' },
      update: {},
      create: { nombre: 'Especialidad Filtros Test' },
    });
    medico = await prisma.medico.create({ data: { nombre: 'Dr. Filtros Test', especialidadId: especialidad.id } });
    pasillo = await prisma.pasillo.upsert({
      where: { nombre: 'Pasillo Filtros Test' },
      update: {},
      create: { nombre: 'Pasillo Filtros Test' },
    });
    box = await prisma.box.create({ data: { nombre: 'Box Filtros Test', pasilloId: pasillo.id } });
    // La exportación de citas solo usa pacienteId, así que los campos cifrados
    // pueden ser bytes cualquiera.
    paciente = await prisma.paciente.create({
      data: {
        nombreCifrado: crypto.randomBytes(32),
        rutCifrado: crypto.randomBytes(32),
        rutIndice: crypto.randomBytes(32),
        fechaNacimiento: new Date('1990-01-01'),
        contactoCifrado: crypto.randomBytes(32),
        motivoConsultaCifrado: crypto.randomBytes(32),
      },
    });

    const base = { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id };
    await prisma.cita.createMany({
      data: [
        { ...base, fecha: new Date('2031-01-10'), horaInicio: '09:00', horaFin: '09:30', estado: 'agendada' },
        { ...base, fecha: new Date('2031-01-20'), horaInicio: '10:00', horaFin: '10:30', estado: 'atendido' },
        { ...base, fecha: new Date('2031-02-05'), horaInicio: '11:00', horaFin: '11:30', estado: 'agendada', anulada: true },
      ],
    });
  });

  afterAll(async () => {
    await prisma.cita.deleteMany({ where: { pacienteId: paciente.id } });
    await prisma.paciente.delete({ where: { id: paciente.id } });
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.pasillo.delete({ where: { id: pasillo.id } });
    await prisma.medico.delete({ where: { id: medico.id } });
    await prisma.especialidad.delete({ where: { id: especialidad.id } });
    await prisma.auditLog.deleteMany({ where: { usuarioId: usuario.id } });
    await prisma.usuario.delete({ where: { id: usuario.id } });
    await prisma.$disconnect();
  });

  it('sin filtros exporta todas las citas, incluidas las anuladas', async () => {
    const { agent } = await loginAgent(app, { email: usuario.email, password });
    const res = await agent.get('/datos/exportar/citas.csv');
    expect(res.status).toBe(200);
    expect(fechasPropias(res.text)).toEqual(['2031-01-10', '2031-01-20', '2031-02-05']);
  });

  it('filtra las citas por rango de fechas inclusivo', async () => {
    const { agent } = await loginAgent(app, { email: usuario.email, password });
    const res = await agent.get('/datos/exportar/citas.csv?desde=2031-01-10&hasta=2031-01-20');
    expect(res.status).toBe(200);
    expect(fechasPropias(res.text)).toEqual(['2031-01-10', '2031-01-20']);
  });

  it('filtra las citas por estado, y "anulada" usa el indicador de anulación', async () => {
    const { agent } = await loginAgent(app, { email: usuario.email, password });
    const anuladas = await agent.get('/datos/exportar/citas.csv?estado=anulada&desde=2031-01-01');
    expect(fechasPropias(anuladas.text)).toEqual(['2031-02-05']);

    // Una cita anulada conserva su estado "agendada", pero no debe salir aquí.
    const agendadas = await agent.get('/datos/exportar/citas.csv?estado=agendada&desde=2031-01-01');
    expect(fechasPropias(agendadas.text)).toEqual(['2031-01-10']);
  });

  it('ignora los filtros vacíos que envía el formulario', async () => {
    const { agent } = await loginAgent(app, { email: usuario.email, password });
    const res = await agent.get('/datos/exportar/citas.csv?desde=&hasta=&estado=');
    expect(res.status).toBe(200);
    expect(fechasPropias(res.text)).toHaveLength(3);
  });

  it('rechaza filtros con formato inválido', async () => {
    const { agent } = await loginAgent(app, { email: usuario.email, password });
    expect((await agent.get('/datos/exportar/citas.csv?desde=10-01-2031')).status).toBe(400);
    expect((await agent.get('/datos/exportar/citas.csv?estado=cualquiera')).status).toBe(400);
    expect((await agent.get('/datos/exportar/auditoria.csv?accion=drop;table')).status).toBe(400);
  });

  it('filtra la auditoría por acción y por rango de fechas', async () => {
    const { agent } = await loginAgent(app, { email: usuario.email, password });
    // Genera al menos un EXPORT propio antes de filtrar.
    await agent.get('/datos/exportar/citas.csv');

    const soloExport = await agent.get('/datos/exportar/auditoria.csv?accion=EXPORT');
    expect(soloExport.status).toBe(200);
    const acciones = new Set(filasDe(soloExport.text).map((f) => f[3]));
    expect([...acciones]).toEqual(['EXPORT']);

    const futuro = await agent.get('/datos/exportar/auditoria.csv?desde=2099-01-01');
    expect(filasDe(futuro.text)).toHaveLength(0);
  });
});
