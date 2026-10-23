const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { limpiarPacientes } = require('../helpers/derechos');
const { seudonimo } = require('../../src/services/pacienteService');

// El reporte estadístico es la única salida anónima de MediBox: agregada, sin
// seudónimo y sin los grupos de menos de 5 pacientes. Un año propio (2097)
// aísla los datos de esta prueba de los del resto de la suite.
describe('Reporte estadístico anónimo (/datos/exportar/estadistica.csv)', () => {
  const password = 'Password123!';
  const ANIO = 2097;
  let gestor;
  let pacientes;
  let especialidad;

  beforeAll(async () => {
    gestor = await usuarioDePrueba('estadistica-gestor@medibox.local', 'gestor', password);
    await usuarioDePrueba('estadistica-consulta@medibox.local', 'consulta', password);
    const medico = await prisma.medico.findFirstOrThrow({ include: { especialidad: true } });
    especialidad = medico.especialidad.nombre;
    const box = await prisma.box.findFirstOrThrow();

    // Cinco adultos mayores (grupo publicable), uno bloqueado en el mismo
    // grupo (no debe contarse) y un niño solo en su tramo (se suprime).
    const adultos = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => pacienteDePrueba({ nombre: `Estadistica Adulto ${n}`, fechaNacimiento: '1990-01-01' })),
    );
    const bloqueado = await pacienteDePrueba({ nombre: 'Estadistica Bloqueado', fechaNacimiento: '1990-01-01' });
    await prisma.paciente.update({ where: { id: bloqueado.id }, data: { bloqueado: true, bloqueadoEl: new Date() } });
    const nino = await pacienteDePrueba({ nombre: 'Estadistica Nino', fechaNacimiento: '2090-01-01' });
    pacientes = [...adultos, bloqueado, nino];

    await prisma.cita.createMany({
      data: pacientes.map((p, i) => ({
        pacienteId: p.id, medicoId: medico.id, boxId: box.id, fecha: new Date(`${ANIO}-03-0${i + 1}`), horaInicio: '08:00', horaFin: '08:20',
      })),
    });
  });

  afterAll(async () => {
    await limpiarPacientes(pacientes.map((p) => p.id));
    await prisma.$disconnect();
  });

  it('entrega los grupos agregados, sin identidad ni seudónimo, y suprime los pequeños', async () => {
    const { agent } = await loginAgent(app, { email: gestor.email, password });
    const res = await agent.get('/datos/exportar/estadistica.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lineas = res.text.trim().split('\r\n');
    expect(lineas[0]).toBe('anio,especialidad,tramoEtario,pacientes,citas');
    const delAnio = lineas.filter((linea) => linea.startsWith(`${ANIO},`));
    expect(delAnio).toEqual([`${ANIO},${especialidad},80+,5,5`]);

    pacientes.forEach((p) => expect(res.text).not.toContain(seudonimo(p.id)));
    expect(res.text).not.toMatch(/Estadistica|P-[0-9A-F]{16}/);
  });

  it('queda en la auditoría como exportación de la estadística', async () => {
    const registro = await prisma.auditLog.findFirst({
      where: { usuarioId: gestor.id, accion: 'EXPORT', entidad: 'Estadistica' },
      orderBy: { id: 'desc' },
    });
    expect(registro.detalle).toEqual({ grupos: expect.any(Number), suprimidos: expect.any(Number) });
    expect(registro.detalle.suprimidos).toBeGreaterThanOrEqual(1);
  });

  it('rechaza a quien no tiene data.export', async () => {
    const { agent } = await loginAgent(app, { email: 'estadistica-consulta@medibox.local', password });
    const res = await agent.get('/datos/exportar/estadistica.csv');
    expect(res.status).toBe(403);
  });
});
