const crypto = require('crypto');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba } = require('../helpers/datos');
const alertas = require('../../src/services/alertasService');

// Monitoreo (Hito 3): reglas fijas sobre la auditoría. Las filas se siembran
// en un día pasado elegido al azar, para que otras corridas no las cuenten.
describe('Alertas de accesos anómalos', () => {
  const password = 'Password123!';
  const usuarios = {};
  // Un día al azar entre 2001 y 2050, a las 00:00 UTC.
  const dia = new Date(Date.UTC(2001, 0, 1) + crypto.randomInt(18000) * 24 * 60 * 60 * 1000);
  const enUtc = (horas, minutos = 0) => new Date(dia.getTime() + (horas * 60 + minutos) * 60 * 1000);
  const ventana = { desde: dia, hasta: enUtc(24) };

  async function fila(datos) {
    return prisma.auditLog.create({ data: { entidad: 'Paciente', entidadId: 1, ...datos } });
  }

  function de(regla, usuario, lista) {
    return lista.filter((a) => a.regla === regla && (!usuario || a.usuarioId === usuario.id));
  }

  beforeAll(async () => {
    for (const clave of ['nocturno', 'diurno', 'masivo', 'normal', 'exportador', 'moderado', 'curioso', 'admin', 'probador', 'viajero', 'habitual', 'nuevo']) {
      usuarios[clave] = await usuarioDePrueba(`alertas-${clave}@medibox.local`, 'consulta', password);
    }
    const emailAtacado = crypto.randomBytes(32);
    const emailPocos = crypto.randomBytes(32);
    for (let i = 0; i < 5; i += 1) await fila({ accion: 'LOGIN_FALLIDO', entidad: 'Usuario', entidadId: 0, resultado: 'fallido', emailIndice: emailAtacado, timestamp: enUtc(15, i * 2) });
    for (let i = 0; i < 4; i += 1) await fila({ accion: 'LOGIN_FALLIDO', entidad: 'Usuario', entidadId: 0, resultado: 'fallido', emailIndice: emailPocos, timestamp: enUtc(15, i * 2) });
    for (let i = 0; i < 5; i += 1) await fila({ usuarioId: usuarios.probador.id, accion: 'VERIFICAR_IDENTIDAD', entidadId: 77, resultado: 'fallido', timestamp: enUtc(16, i) });

    // 06:00 UTC es madrugada en Chile (02:00 o 03:00); 15:00 UTC, media mañana.
    await fila({ usuarioId: usuarios.nocturno.id, accion: 'READ', timestamp: enUtc(6) });
    await fila({ usuarioId: usuarios.diurno.id, accion: 'READ', timestamp: enUtc(15) });

    for (let i = 1; i <= 31; i += 1) await fila({ usuarioId: usuarios.masivo.id, accion: 'READ', entidadId: i, timestamp: enUtc(14, i) });
    for (let i = 1; i <= 30; i += 1) await fila({ usuarioId: usuarios.normal.id, accion: 'READ', entidadId: i, timestamp: enUtc(14, i) });
    for (let i = 0; i < 4; i += 1) await fila({ usuarioId: usuarios.exportador.id, accion: 'EXPORT', entidadId: 0, timestamp: enUtc(13, i) });
    for (let i = 0; i < 3; i += 1) await fila({ usuarioId: usuarios.moderado.id, accion: 'EXPORT', entidadId: 0, timestamp: enUtc(13, i) });

    await fila({ usuarioId: usuarios.curioso.id, accion: 'READ', resultado: 'denegado', entidadId: 99, timestamp: enUtc(15) });
    await fila({ usuarioId: usuarios.admin.id, accion: 'UPDATE_PERMISOS', entidad: 'Rol', entidadId: 3, timestamp: enUtc(15) });

    // Inicios de sesión: el viajero entró hace 5 días desde otra IP; el
    // habitual, desde la misma; el nuevo no tiene historial.
    const login = (usuario, ip, timestamp) => fila({ usuarioId: usuario.id, accion: 'LOGIN', entidad: 'Usuario', entidadId: usuario.id, ip, timestamp });
    await login(usuarios.viajero, '10.0.0.1', enUtc(-24 * 5));
    await login(usuarios.viajero, '203.0.113.9', enUtc(12));
    await login(usuarios.habitual, '10.0.0.2', enUtc(-24 * 5));
    await login(usuarios.habitual, '10.0.0.2', enUtc(12));
    await login(usuarios.nuevo, '10.0.0.3', enUtc(12));

    await fila({ actor: 'portal', accion: 'PORTAL_LIMITADO', entidad: 'Sistema', entidadId: 0, resultado: 'denegado', timestamp: enUtc(17) });
    await fila({ actor: 'portal', accion: 'PORTAL_CODIGO', entidadId: 55, resultado: 'denegado', timestamp: enUtc(17, 5) });
  });

  afterAll(() => prisma.$disconnect());

  it('detecta muchos inicios de sesión fallidos sobre una misma cuenta, y no los que están bajo el umbral', async () => {
    const encontradas = de('FALLIDOS', null, await alertas.detectar(ventana));
    expect(encontradas).toHaveLength(1);
    expect(encontradas[0].cantidad).toBe(5);
  });

  it('detecta a quien prueba muchos códigos de verificación sobre un paciente', async () => {
    expect(de('CODIGOS_FALLIDOS', usuarios.probador, await alertas.detectar(ventana))).toHaveLength(1);
  });

  it('detecta accesos a pacientes fuera del horario habitual', async () => {
    const lista = await alertas.detectar(ventana);
    expect(de('FUERA_DE_HORARIO', usuarios.nocturno, lista)).toHaveLength(1);
    expect(de('FUERA_DE_HORARIO', usuarios.diurno, lista)).toHaveLength(0);
  });

  it('detecta un volumen anómalo de lecturas y de exportaciones', async () => {
    const lista = await alertas.detectar(ventana);
    expect(de('VOLUMEN_LECTURAS', usuarios.masivo, lista)).toEqual([expect.objectContaining({ cantidad: 31 })]);
    expect(de('VOLUMEN_LECTURAS', usuarios.normal, lista)).toHaveLength(0);
    expect(de('VOLUMEN_EXPORTACIONES', usuarios.exportador, lista)).toHaveLength(1);
    expect(de('VOLUMEN_EXPORTACIONES', usuarios.moderado, lista)).toHaveLength(0);
  });

  it('detecta accesos negados (datos ajenos a la función) y cambios de acceso', async () => {
    const lista = await alertas.detectar(ventana);
    expect(de('FUERA_DE_FUNCION', usuarios.curioso, lista)).toHaveLength(1);
    expect(de('CAMBIO_DE_ACCESO', usuarios.admin, lista)).toHaveLength(1);
  });

  it('detecta un inicio de sesión desde una IP que la cuenta no usaba', async () => {
    const lista = await alertas.detectar(ventana);
    expect(de('IP_NUEVA', usuarios.viajero, lista)).toHaveLength(1);
    expect(de('IP_NUEVA', usuarios.habitual, lista)).toHaveLength(0);
    // La primera vez de una cuenta no es una ubicación inusual.
    expect(de('IP_NUEVA', usuarios.nuevo, lista)).toHaveLength(0);
  });

  it('detecta el abuso del portal del paciente', async () => {
    expect(de('PORTAL_ABUSO', null, await alertas.detectar(ventana))).toEqual([expect.objectContaining({ cantidad: 2, usuarioId: null })]);
  });

  it('no entrega datos de pacientes: ni ids ni identidad', async () => {
    const texto = JSON.stringify(await alertas.detectar(ventana));
    expect(texto).not.toMatch(/entidadId|pacienteId|emailIndice/);
  });

  it('no acepta una ventana de más de 31 días', async () => {
    await expect(alertas.detectar({ desde: dia, hasta: enUtc(24 * 40) })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('/alertas es para quien audita: 200 al gestor, 403 al operador', async () => {
    const gestor = await usuarioDePrueba('alertas-gestor@medibox.local', 'gestor', password);
    const operador = await usuarioDePrueba('alertas-operador@medibox.local', 'operador', password);
    const { agent } = await loginAgent(app, { email: gestor.email, password });
    const fechaDia = dia.toISOString().slice(0, 10);
    const res = await agent.get(`/alertas?desde=${fechaDia}&hasta=${fechaDia}`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Fuera de horario');
    const { agent: agentOperador } = await loginAgent(app, { email: operador.email, password });
    expect((await agentOperador.get('/alertas')).status).toBe(403);
  });

  it('notificarAlertas avisa a los gestores sin identificar a nadie', async () => {
    const gestor = await usuarioDePrueba('alertas-gestor@medibox.local', 'gestor', password);
    await fila({ usuarioId: usuarios.curioso.id, accion: 'READ', resultado: 'denegado', entidadId: 98 });
    const antes = new Date();
    const { alertas: cantidad } = await alertas.notificarAlertas();
    expect(cantidad).toBeGreaterThan(0);
    const aviso = await prisma.notificacion.findFirst({ where: { usuarioId: gestor.id, createdAt: { gte: antes } } });
    expect(aviso.mensaje).toMatch(/alerta/);
    expect(aviso.mensaje).not.toMatch(/Paciente|RUT/);
    await prisma.notificacion.deleteMany({ where: { usuarioId: gestor.id, createdAt: { gte: antes } } });
  });
});
