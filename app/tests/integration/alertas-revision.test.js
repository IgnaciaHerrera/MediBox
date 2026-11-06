const crypto = require('crypto');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba } = require('../helpers/datos');
const alertas = require('../../src/services/alertasService');

// Alertas con dueño y plazo: cada una se guarda, se avisa a su responsable,
// se revisa dentro del plazo (descartada con motivo o escalada a un
// incidente) y, si vence, se escala a privacidad.
describe('revisión de alertas', () => {
  const password = 'Password123!';
  const sufijo = crypto.randomBytes(4).toString('hex');
  let gestor;
  let privacidad;
  let sospechoso;

  // Más de 30 pacientes distintos leídos en una hora: VOLUMEN_LECTURAS
  // (alta, la revisa privacidad en 4 horas).
  async function lecturasMasivas(usuario, inicio) {
    for (let i = 1; i <= 31; i += 1) {
      await prisma.auditLog.create({
        data: {
          usuarioId: usuario.id,
          accion: 'READ',
          entidad: 'Paciente',
          entidadId: 100000 + i,
          timestamp: new Date(inicio.getTime() + i * 1000),
        },
      });
    }
  }

  beforeAll(async () => {
    gestor = await usuarioDePrueba(`rev-gestor-${sufijo}@medibox.local`, 'gestor', password);
    privacidad = await usuarioDePrueba(
      `rev-privacidad-${sufijo}@medibox.local`,
      'privacidad',
      password,
    );
    sospechoso = await usuarioDePrueba(
      `rev-sospechoso-${sufijo}@medibox.local`,
      'operador',
      password,
    );
  });

  afterAll(() => prisma.$disconnect());

  it('guarda la alerta con su severidad, su responsable y su plazo, y no la duplica en la revisión siguiente', async () => {
    const inicio = new Date(Date.now() - 30 * 60 * 1000);
    await lecturasMasivas(sospechoso, inicio);
    const ahora = new Date();
    const { nuevas } = await alertas.analizar(
      { desde: new Date(ahora - 60 * 60 * 1000), hasta: ahora },
      ahora,
    );
    const alerta = nuevas.find(
      (a) => a.regla === 'VOLUMEN_LECTURAS' && a.usuarioId === sospechoso.id,
    );
    expect(alerta).toEqual(
      expect.objectContaining({
        severidad: 'alta',
        responsable: 'privacidad',
        estado: 'pendiente',
        cantidad: 31,
      }),
    );
    expect(alerta.revisarAntesDe.getTime() - ahora.getTime()).toBe(4 * 60 * 60 * 1000);

    const otra = await alertas.analizar({
      desde: new Date(ahora - 2 * 60 * 60 * 1000),
      hasta: new Date(),
    });
    expect(
      otra.nuevas.filter((a) => a.usuarioId === sospechoso.id && a.regla === 'VOLUMEN_LECTURAS'),
    ).toEqual([]);
    expect(
      await prisma.alerta.count({ where: { regla: 'VOLUMEN_LECTURAS', usuarioId: sospechoso.id } }),
    ).toBe(1);
  });

  it('avisa al rol responsable con la severidad y el plazo, sin identificar a nadie', async () => {
    const otro = await usuarioDePrueba(`rev-otro-${sufijo}@medibox.local`, 'operador', password);
    await lecturasMasivas(otro, new Date(Date.now() - 20 * 60 * 1000));
    const antes = new Date();
    await alertas.notificarAlertas();
    const aviso = await prisma.notificacion.findFirst({
      where: {
        usuarioId: privacidad.id,
        createdAt: { gte: antes },
        mensaje: { contains: 'Volumen de lecturas' },
      },
    });
    expect(aviso.mensaje).toMatch(
      /^Alerta alta N° \d+: Volumen de lecturas\. Revísala en Alertas antes del /,
    );
    expect(aviso.mensaje).not.toContain(otro.nombre);
  });

  it('descartar exige el motivo, y nadie revisa una alerta sobre su propia cuenta', async () => {
    const alerta = await prisma.alerta.findFirst({
      where: { regla: 'VOLUMEN_LECTURAS', usuarioId: sospechoso.id },
    });
    await expect(alertas.descartar(alerta.id, 'corto', privacidad)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      alertas.descartar(alerta.id, 'Era una auditoría interna autorizada', sospechoso),
    ).rejects.toMatchObject({ statusCode: 403 });

    const { agent } = await loginAgent(app, { email: privacidad.email, password });
    const res = await agent
      .post(`/alertas/${alerta.id}/descartar`)
      .send({ motivo: 'Revisión de fichas autorizada por la jefatura de admisión' });
    expect(res.status).toBe(200);
    const revisada = await prisma.alerta.findUnique({ where: { id: alerta.id } });
    expect(revisada).toEqual(
      expect.objectContaining({ estado: 'descartada', revisadaPorId: privacidad.id }),
    );
    expect(
      await prisma.auditLog.count({
        where: { accion: 'REVISAR_ALERTA', entidad: 'Alerta', entidadId: alerta.id },
      }),
    ).toBe(1);
    await expect(
      alertas.descartar(alerta.id, 'Segunda revisión de lo mismo', privacidad),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('actividad posterior a una alerta revisada abre una alerta nueva', async () => {
    const descartada = await prisma.alerta.findFirst({
      where: { regla: 'VOLUMEN_LECTURAS', usuarioId: sospechoso.id, estado: 'descartada' },
    });
    await lecturasMasivas(sospechoso, new Date(descartada.hasta.getTime() + 2 * 60 * 1000));
    const ahora = new Date();
    const { nuevas } = await alertas.analizar(
      { desde: new Date(ahora - 60 * 60 * 1000), hasta: ahora },
      ahora,
    );
    expect(
      nuevas.filter((a) => a.regla === 'VOLUMEN_LECTURAS' && a.usuarioId === sospechoso.id),
    ).toHaveLength(1);
  });

  it('escalar una alerta registra el incidente y deja la alerta enlazada, en una sola operación', async () => {
    const alerta = await prisma.alerta.findFirst({
      where: { regla: 'VOLUMEN_LECTURAS', usuarioId: sospechoso.id, estado: 'pendiente' },
    });
    const { agent } = await loginAgent(app, { email: privacidad.email, password });
    const formulario = await agent
      .get(`/incidentes?alerta=${alerta.id}`)
      .set('Accept', 'text/html');
    expect(formulario.status).toBe(200);
    expect(formulario.text).toContain(`Escalar la alerta N° ${alerta.id}`);

    const res = await agent.post('/incidentes').send({
      alertaId: alerta.id,
      titulo: `Alerta N° ${alerta.id}: Volumen de lecturas`,
      origen: 'alerta_automatica',
      severidad: 'alta',
      dimension: 'confidencialidad',
      descripcion: 'Una cuenta de operador leyó más de 30 fichas en una hora.',
      cuentaInvolucradaId: sospechoso.id,
    });
    expect(res.status).toBe(200);
    const escalada = await prisma.alerta.findUnique({ where: { id: alerta.id } });
    expect(escalada).toEqual(
      expect.objectContaining({
        estado: 'escalada',
        incidenteId: res.body.id,
        revisadaPorId: privacidad.id,
      }),
    );
    const incidente = await prisma.incidente.findUnique({ where: { id: res.body.id } });
    expect(incidente.cuentaInvolucradaId).toBe(sospechoso.id);

    // Ya revisada: no se escala dos veces.
    const repetida = await agent
      .post('/incidentes')
      .send({
        alertaId: alerta.id,
        titulo: 'Otra vez la misma alerta',
        origen: 'alerta_automatica',
        severidad: 'alta',
        dimension: 'confidencialidad',
        descripcion: 'Intento de escalar dos veces.',
      });
    expect(repetida.status).toBe(409);
  });

  it('dos revisiones simultáneas de la misma alerta: gana una, la otra recibe 409', async () => {
    const alerta = await prisma.alerta.create({
      data: {
        regla: 'IP_NUEVA',
        sujeto: `u:${sospechoso.id}`,
        usuarioId: sospechoso.id,
        cantidad: 1,
        desde: new Date('2001-01-02T10:00:00Z'),
        hasta: new Date('2001-01-02T10:00:00Z'),
        severidad: 'baja',
        responsable: 'gestor',
        revisarAntesDe: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const resultados = await Promise.allSettled([
      alertas.descartar(alerta.id, 'Viaje de trabajo informado por la jefatura', gestor),
      alertas.descartar(alerta.id, 'Viaje de trabajo confirmado por privacidad', privacidad),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(resultados.find((r) => r.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
    expect(await prisma.auditLog.count({ where: { accion: 'REVISAR_ALERTA', entidadId: alerta.id } })).toBe(1);
  });

  it('una alerta que vence sin revisarse se avisa una sola vez a privacidad', async () => {
    const vencida = await prisma.alerta.create({
      data: {
        regla: 'FALLIDOS',
        sujeto: `u:${gestor.id}`,
        usuarioId: gestor.id,
        cantidad: 5,
        desde: new Date('2001-01-01T10:00:00Z'),
        hasta: new Date('2001-01-01T10:10:00Z'),
        severidad: 'media',
        responsable: 'gestor',
        revisarAntesDe: new Date(Date.now() - 60 * 1000),
      },
    });
    const antes = new Date();
    await alertas.notificarAlertas();
    await alertas.notificarAlertas();
    const avisos = await prisma.notificacion.findMany({
      where: {
        usuarioId: privacidad.id,
        createdAt: { gte: antes },
        mensaje: { contains: `N° ${vencida.id} ` },
      },
    });
    expect(avisos).toHaveLength(1);
    expect(avisos[0].mensaje).toMatch(/venció sin revisarse/);
    // La alerta es sobre el gestor: a él no le llega.
    expect(
      await prisma.notificacion.count({
        where: {
          usuarioId: gestor.id,
          createdAt: { gte: antes },
          mensaje: { contains: `N° ${vencida.id} ` },
        },
      }),
    ).toBe(0);
  });

  it('/alertas: el gestor y privacidad la ven con severidad, responsable y plazo; el operador no', async () => {
    const { agent } = await loginAgent(app, { email: gestor.email, password });
    const res = await agent.get('/alertas?estado=todas').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Revisar antes de');
    expect(res.text).toContain('Intentos de escalar privilegios');
    const { agent: operador } = await loginAgent(app, { email: sospechoso.email, password });
    expect((await operador.get('/alertas')).status).toBe(403);
  });
});
