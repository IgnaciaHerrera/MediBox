const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { seudonimo } = require('../../src/services/pacienteService');

describe('Importación y exportación de datos (data.export / data.import)', () => {
  const password = 'Password123!';
  let usuarioExportador;
  let rolSoloExport;
  let rolSoloImport;
  let pacienteId;

  beforeAll(async () => {
    // El gestor exporta e importa: no lee la identidad de los pacientes, y
    // ninguna exportación la contiene.
    const rolGestor = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'gestor' } });
    const rolConsulta = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'consulta' } });
    const rolOperador = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'operador' } });

    // Roles a medida para probar que data.export/data.import por sí solos no
    // bastan: cada endpoint exige además el permiso de la entidad concreta.
    const permisoExport = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'data.export' } });
    const permisoImport = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'data.import' } });

    rolSoloExport = await prisma.rol.upsert({
      where: { nombre: 'datos-test-solo-export' },
      update: {},
      create: { nombre: 'datos-test-solo-export' },
    });
    await prisma.rolPermiso.deleteMany({ where: { rolId: rolSoloExport.id } });
    await prisma.rolPermiso.create({ data: { rolId: rolSoloExport.id, permisoId: permisoExport.id } });

    rolSoloImport = await prisma.rol.upsert({
      where: { nombre: 'datos-test-solo-import' },
      update: {},
      create: { nombre: 'datos-test-solo-import' },
    });
    await prisma.rolPermiso.deleteMany({ where: { rolId: rolSoloImport.id } });
    await prisma.rolPermiso.create({ data: { rolId: rolSoloImport.id, permisoId: permisoImport.id } });

    usuarioExportador = await prisma.usuario.upsert({
      where: { email: 'datos-exportador-test@medibox.local' },
      update: {},
      create: { nombre: 'Exportador Datos Test', email: 'datos-exportador-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolGestor.id },
    });
    await prisma.usuario.upsert({
      where: { email: 'datos-sinpermisos-test@medibox.local' },
      update: {},
      create: { nombre: 'Sin Permisos Datos Test', email: 'datos-sinpermisos-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolConsulta.id },
    });
    await prisma.usuario.upsert({
      where: { email: 'datos-soloexport-test@medibox.local' },
      update: {},
      create: { nombre: 'Solo Export Test', email: 'datos-soloexport-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolSoloExport.id },
    });
    await prisma.usuario.upsert({
      where: { email: 'datos-soloimport-test@medibox.local' },
      update: {},
      create: { nombre: 'Solo Import Test', email: 'datos-soloimport-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolSoloImport.id },
    });
    await prisma.usuario.upsert({
      where: { email: 'datos-operador-test@medibox.local' },
      update: {},
      create: { nombre: 'Operador Datos Test', email: 'datos-operador-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rolOperador.id },
    });

    const { agent } = await loginAgent(app, { email: 'datos-operador-test@medibox.local', password });
    const pacienteRes = await agent.post('/api/pacientes').send({
      nombre: 'Paciente Export Test', rut: '17171717-5', fechaNacimiento: '1990-05-05', contacto: '+56900009999',
    });
    pacienteId = pacienteRes.body.id;
  });

  afterAll(async () => {
    // Los usuarios de prueba (y sus roles) se conservan y se reutilizan con
    // upsert: tienen filas en la auditoría, que es de solo inserción.
    const pasillosImportados = await prisma.pasillo.findMany({
      where: { nombre: { in: ['Pasillo Import Test', 'Pasillo Import Test 2'] } },
    });
    const pasilloIds = pasillosImportados.map((p) => p.id);
    if (pasilloIds.length > 0) {
      await prisma.box.deleteMany({ where: { pasilloId: { in: pasilloIds } } });
      await prisma.pasillo.deleteMany({ where: { id: { in: pasilloIds } } });
    }
    if (pacienteId) {
      await prisma.paciente.deleteMany({ where: { id: pacienteId } });
    }
    await prisma.$disconnect();
  });

  it('rejects the index page for a user with neither data.export nor data.import', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'datos-sinpermisos-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/datos');
    expect(res.status).toBe(403);
  });

  it('data.export alone is not enough to export an entity the role cannot read', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'datos-soloexport-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    expect((await agent.get('/datos')).status).toBe(200);
    // El reporte de pacientes no identifica a nadie: basta data.export.
    expect((await agent.get('/datos/exportar/pacientes.csv')).status).toBe(200);
    expect((await agent.get('/datos/exportar/citas.csv')).status).toBe(403);
    expect((await agent.get('/datos/exportar/auditoria.csv')).status).toBe(403);
  });

  it('data.import alone is not enough to import spaces without box.write', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'datos-soloimport-test@medibox.local', password });
    expect(loginRes.status).toBe(200);
    const res = await agent.post('/datos/importar/espacios').send({ csv: 'Pasillo Import Test,Box 1' });
    expect(res.status).toBe(403);
    const pasillo = await prisma.pasillo.findUnique({ where: { nombre: 'Pasillo Import Test' } });
    expect(pasillo).toBeNull();
  });

  it('exports pacientes pseudonymized, with no identity, and audits the export', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'datos-exportador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.get('/datos/exportar/pacientes.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [cabecera, ...filas] = res.text.trim().split('\r\n');
    expect(cabecera).toBe('paciente,tramoEtario,anioRegistro,citas');
    // Ni nombre, ni RUT, ni fecha exacta, ni contacto: solo el seudónimo y
    // datos generalizados (nació en 1990: hoy está en el tramo de los 30).
    expect(res.text).not.toMatch(/Paciente Export Test|17171717|1990-05-05|56900009999/);
    const fila = filas.find((f) => f.startsWith(`${seudonimo(pacienteId)},`));
    expect(fila).toMatch(/^P-[0-9A-F]{16},30-39,\d{4},0$/);

    const auditoria = await prisma.auditLog.findFirst({
      where: { usuarioId: usuarioExportador.id, accion: 'EXPORT', entidad: 'Paciente' },
      orderBy: { id: 'desc' },
    });
    expect(auditoria).not.toBeNull();
  });

  it('exports citas as CSV without patient name or clinical data, only the patient pseudonym', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'datos-exportador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.get('/datos/exportar/citas.csv');
    expect(res.status).toBe(200);
    const cabecera = res.text.split('\r\n')[0];
    expect(cabecera).toBe('id,paciente,medico,pasillo,box,fecha,horaInicio,horaFin,estado,anulada');
    expect(cabecera).not.toMatch(/nombre|rut|motivo/i);
  });

  it('exports the audit log as CSV and audits that export too', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'datos-exportador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const res = await agent.get('/datos/exportar/auditoria.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // La creación del paciente de este archivo aparece con su seudónimo,
    // no con su id: es la misma referencia que en el CSV de citas.
    expect(res.text).toContain(`,CREATE,Paciente,${seudonimo(pacienteId)}`);
    expect(res.text).not.toContain(`,CREATE,Paciente,${pacienteId}\r\n`);

    const auditoria = await prisma.auditLog.findFirst({
      where: { usuarioId: usuarioExportador.id, accion: 'EXPORT', entidad: 'AuditLog' },
      orderBy: { id: 'desc' },
    });
    expect(auditoria).not.toBeNull();
  });

  it('imports espacios from CSV, is idempotent on re-import, and rejects malformed rows atomically', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'datos-exportador-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const csv = 'pasillo,box\nPasillo Import Test,Box A\nPasillo Import Test,Box B';
    const primerRes = await agent.post('/datos/importar/espacios').send({ csv });
    expect(primerRes.status).toBe(200);

    const pasillo = await prisma.pasillo.findUniqueOrThrow({ where: { nombre: 'Pasillo Import Test' } });
    const boxes = await prisma.box.findMany({ where: { pasilloId: pasillo.id } });
    expect(boxes.map((b) => b.nombre).sort()).toEqual(['Box A', 'Box B']);

    const segundoRes = await agent.post('/datos/importar/espacios').send({ csv });
    expect(segundoRes.status).toBe(200);
    const boxesTrasSegundo = await prisma.box.findMany({ where: { pasilloId: pasillo.id } });
    expect(boxesTrasSegundo).toHaveLength(2);

    const csvMalformado = 'pasillo,box\nPasillo Import Test 2,Box C\nesto no es una fila válida';
    const resMalo = await agent.post('/datos/importar/espacios').send({ csv: csvMalformado });
    expect(resMalo.status).toBe(400);
    const pasilloFallido = await prisma.pasillo.findUnique({ where: { nombre: 'Pasillo Import Test 2' } });
    expect(pasilloFallido).toBeNull();
  });
});
