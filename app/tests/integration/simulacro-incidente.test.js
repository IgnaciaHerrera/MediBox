const crypto = require('crypto');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const alertas = require('../../src/services/alertasService');
const incidentes = require('../../src/services/incidenteService');
const { cambiarSuspension } = require('../../src/services/usuarioService');

// Simulacro reproducible del plan de respuesta: una cuenta de operador
// comprometida lee 35 fichas en pocos minutos e intenta llegar a funciones
// de administración. Todo pasa por la aplicación real (HTTP), así que la
// auditoría es la que quedaría en producción. Al final se comprueba que los
// registros permiten reconstruir lo ocurrido: quién, qué, sobre qué, cuándo,
// desde dónde y con qué resultado. Datos sintéticos, nunca reales.
describe('simulacro: cuenta de operador comprometida', () => {
  const password = 'Password123!';
  const sufijo = crypto.randomBytes(4).toString('hex');
  const FICHAS = 35;
  let comprometida;
  let privacidad;
  let pacientes;
  let inicio;
  let fin;
  let incidenteId;

  beforeAll(async () => {
    comprometida = await usuarioDePrueba(
      `sim-operador-${sufijo}@medibox.local`,
      'operador',
      password,
    );
    privacidad = await usuarioDePrueba(
      `sim-privacidad-${sufijo}@medibox.local`,
      'privacidad',
      password,
    );
    pacientes = [];
    for (let i = 0; i < FICHAS; i += 1)
      pacientes.push(
        await pacienteDePrueba({
          nombre: `Paciente Simulacro ${i}`,
          fechaNacimiento: i < 5 ? '2015-03-01' : '1980-03-01',
        }),
      );

    // 1. El ataque.
    inicio = new Date(Date.now() - 1000);
    const { agent: atacante } = await loginAgent(app, { email: comprometida.email, password });
    for (const p of pacientes)
      expect((await atacante.get(`/pacientes/${p.id}`).set('Accept', 'text/html')).status).toBe(
        200,
      );
    for (const ruta of ['/usuarios', '/roles', '/auditoria'])
      expect((await atacante.get(ruta).set('Accept', 'text/html')).status).toBe(403);
    await atacante.post('/auth/logout');
    fin = new Date();
  });

  afterAll(async () => {
    await cambiarSuspension(comprometida.id, false, { actor: 'sistema' });
    await prisma.$disconnect();
  });

  it('2. detección: las reglas levantan las alertas y avisan a su responsable', async () => {
    const antes = new Date();
    await alertas.notificarAlertas();
    const deLaCuenta = await prisma.alerta.findMany({
      where: { usuarioId: comprometida.id, estado: 'pendiente' },
    });
    // De noche se suma la de fuera de horario: la detección no depende de una sola regla.
    expect(deLaCuenta.map((a) => a.regla)).toEqual(
      expect.arrayContaining(['PRIVILEGIOS_NEGADOS', 'VOLUMEN_LECTURAS']),
    );
    const volumen = deLaCuenta.find((a) => a.regla === 'VOLUMEN_LECTURAS');
    expect(volumen).toEqual(
      expect.objectContaining({ severidad: 'alta', responsable: 'privacidad', cantidad: FICHAS }),
    );
    expect(
      await prisma.notificacion.count({
        where: {
          usuarioId: privacidad.id,
          createdAt: { gte: antes },
          mensaje: { contains: `N° ${volumen.id}:` },
        },
      }),
    ).toBe(1);
  });

  it('3. análisis: privacidad escala la alerta a un incidente con la cuenta y el período', async () => {
    const alerta = await prisma.alerta.findFirst({
      where: { usuarioId: comprometida.id, regla: 'VOLUMEN_LECTURAS' },
    });
    const { agent } = await loginAgent(app, { email: privacidad.email, password });
    const res = await agent.post('/incidentes').send({
      alertaId: alerta.id,
      titulo: `Alerta N° ${alerta.id}: Volumen de lecturas`,
      origen: 'alerta_automatica',
      severidad: 'alta',
      dimension: 'confidencialidad',
      descripcion:
        'Una cuenta de operador leyó 35 fichas en minutos e intentó entrar a usuarios, roles y auditoría.',
      ocurridoDesde: inicio.toISOString(),
      ocurridoHasta: fin.toISOString(),
      cuentaInvolucradaId: comprometida.id,
    });
    expect(res.status).toBe(200);
    incidenteId = res.body.id;
    expect((await prisma.alerta.findUnique({ where: { id: alerta.id } })).estado).toBe('escalada');
  });

  it('4. contención: se preserva la evidencia antes de suspender la cuenta, y todo queda en la bitácora', async () => {
    const evidencia = await incidentes.preservarEvidencia({
      desde: inicio,
      hasta: new Date(),
      usuarioId: comprometida.id,
      incidenteId,
    });
    expect(evidencia.filas).toBeGreaterThanOrEqual(FICHAS + 5);
    await cambiarSuspension(comprometida.id, true, { actor: 'sistema', incidenteId });

    // El atacante ya no entra, aunque tenga la contraseña.
    const { loginRes } = await loginAgent(app, { email: comprometida.email, password });
    expect(loginRes.status).toBe(401);

    const { agent } = await loginAgent(app, { email: privacidad.email, password });
    const anotada = await agent
      .post(`/incidentes/${incidenteId}/acciones`)
      .send({
        fase: 'contencion',
        descripcion: 'Se bloqueó en el firewall la IP de origen del acceso.',
        realizadaEl: new Date().toISOString(),
      });
    expect(anotada.status).toBe(200);

    const bitacora = await incidentes.bitacora(incidenteId);
    const textos = bitacora.map((b) => b.descripcion).join('\n');
    expect(textos).toMatch(/Registro de un incidente/);
    expect(textos).toMatch(/Revisión de una alerta/);
    expect(textos).toMatch(/Copia de la auditoría de una ventana/);
    expect(textos).toMatch(/Suspensión de una cuenta/);
    expect(textos).toMatch(/Cierre forzado de las sesiones/);
    expect(textos).toMatch(/firewall/);
    expect(bitacora.map((b) => b.el)).toEqual([...bitacora.map((b) => b.el)].sort((a, b) => a - b));
  });

  it('5. alcance: 35 titulares con datos de salud, 5 de ellos menores de 14', async () => {
    const alcance = await incidentes.estimarAlcance({
      desde: inicio,
      hasta: fin,
      usuarioId: comprometida.id,
      incidenteId,
    });
    expect(alcance.titulares).toBe(FICHAS);
    expect(alcance.porCategoria.salud).toBe(FICHAS);
    expect(alcance.menores14).toBe(5);
  });

  it('6. reconstrucción: la auditoría responde quién, qué, sobre qué, cuándo, desde dónde y con qué resultado', async () => {
    const { eventos, resumen } = await incidentes.reconstruir(
      { desde: inicio, hasta: new Date(), usuarioId: comprometida.id, incidenteId },
      privacidad,
    );
    const acciones = eventos.map((e) => e.accion);

    // En orden: entra, lee las 35 fichas, intenta administrar, sale; después,
    // la contención y el intento de volver a entrar.
    expect(acciones[0]).toBe('LOGIN');
    expect(acciones.slice(1, 1 + FICHAS)).toEqual(Array(FICHAS).fill('READ'));
    expect(acciones.slice(1 + FICHAS, 4 + FICHAS)).toEqual([
      'ACCESO_DENEGADO',
      'ACCESO_DENEGADO',
      'ACCESO_DENEGADO',
    ]);
    expect(acciones).toEqual(
      expect.arrayContaining(['LOGOUT', 'SUSPENDER_CUENTA', 'CERRAR_SESIONES', 'LOGIN_FALLIDO']),
    );
    expect(acciones.indexOf('LOGOUT')).toBeLessThan(acciones.indexOf('SUSPENDER_CUENTA'));

    // Sobre qué: exactamente las 35 fichas, sin contenido de los datos.
    const leidas = eventos
      .filter((e) => e.accion === 'READ')
      .map((e) => e.entidadId)
      .sort((a, b) => a - b);
    expect(leidas).toEqual(pacientes.map((p) => p.id).sort((a, b) => a - b));
    expect(resumen.pacientesDistintos).toBe(FICHAS);
    expect(resumen.denegados).toBe(3);
    expect(resumen.ips).toEqual([expect.stringContaining('127.0.0.1')]);
    expect(eventos.every((e) => e.timestamp >= inicio)).toBe(true);
    expect(JSON.stringify(eventos)).not.toMatch(/Paciente Simulacro/);
  });

  it('7. la ficha del incidente muestra la reconstrucción, la bitácora y la gravedad sugerida', async () => {
    const { agent } = await loginAgent(app, { email: privacidad.email, password });
    await agent.post(`/incidentes/${incidenteId}`).send({
      titulo: 'Cuenta de operador comprometida',
      origen: 'alerta_automatica',
      severidad: 'alta',
      dimension: 'confidencialidad',
      descripcion:
        'Una cuenta de operador leyó 35 fichas en minutos e intentó entrar a usuarios, roles y auditoría.',
      ocurridoDesde: inicio.toISOString(),
      ocurridoHasta: new Date().toISOString(),
      cuentaInvolucradaId: comprometida.id,
      categoriasDatos: ['identidad', 'contacto', 'salud', 'menores'],
      titularesAfectados: FICHAS,
      incluyeMenores: 'si',
    });
    const res = await agent.get(`/incidentes/${incidenteId}`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Reconstrucción desde la auditoría');
    expect(res.text).toMatch(/<strong>35<\/strong> pacientes distintos/);
    expect(res.text).toContain('Bitácora de la respuesta');
    expect(res.text).toContain('firewall');
    expect(res.text).toContain('Coincide con el criterio del plan');
    expect(
      await prisma.auditLog.count({
        where: {
          accion: 'RECONSTRUIR',
          entidad: 'Incidente',
          entidadId: incidenteId,
          usuarioId: privacidad.id,
        },
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('8. lecciones y cierre: el caso se cierra solo con medidas, lecciones y la notificación decidida', async () => {
    const { agent } = await loginAgent(app, { email: privacidad.email, password });
    for (const estado of ['sospechoso', 'confirmado'])
      expect((await agent.post(`/incidentes/${incidenteId}/estado`).send({ estado })).status).toBe(
        200,
      );
    expect(
      (await agent.post(`/incidentes/${incidenteId}/estado`).send({ estado: 'cerrado' })).status,
    ).toBe(409);
    const ahora = new Date().toISOString();
    await agent.post(`/incidentes/${incidenteId}`).send({
      titulo: 'Cuenta de operador comprometida',
      origen: 'alerta_automatica',
      severidad: 'alta',
      dimension: 'confidencialidad',
      descripcion:
        'Una cuenta de operador leyó 35 fichas en minutos e intentó entrar a usuarios, roles y auditoría.',
      categoriasDatos: ['identidad', 'contacto', 'salud', 'menores'],
      titularesAfectados: FICHAS,
      incluyeMenores: 'si',
      medidas:
        'Cuenta suspendida, sesiones cerradas, IP bloqueada en el firewall y contraseña restablecida.',
      lecciones: 'Exigir segundo factor a las cuentas con acceso a fichas.',
      notificadoAgenciaEl: ahora,
      notificadoTitularesEl: ahora,
    });
    expect(
      (await agent.post(`/incidentes/${incidenteId}/estado`).send({ estado: 'cerrado' })).status,
    ).toBe(200);
    const cerrado = await incidentes.obtener(incidenteId);
    expect(cerrado.estado).toBe('cerrado');
    expect(cerrado.borrador).toContain('Titulares afectados (aproximado): 35');
    // Cerrado, la bitácora ya no cambia.
    await expect(
      incidentes.registrarAccion(
        incidenteId,
        { fase: 'lecciones', descripcion: 'Anotación tardía', realizadaEl: ahora },
        privacidad,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
