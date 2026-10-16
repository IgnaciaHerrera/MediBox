const bcrypt = require('bcrypt');
const request = require('supertest');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { indiceEmail } = require('../../src/services/auditService');

// Auditoría del Hito 3: quién (o el sistema), qué, sobre qué, cuándo, desde
// dónde y con qué resultado, sin guardar el dato personal mismo. Los
// usuarios de prueba se reutilizan entre corridas (upsert) y la auditoría no
// se borra: la tabla es de solo inserción.
describe('Auditoría ampliada: actor, resultado e IP', () => {
  const email = 'auditoria-ampliada-test@medibox.local';
  const password = 'Password123!';
  let usuario;
  let inicio;

  async function login(credenciales) {
    const agent = request.agent(app);
    const token = (await agent.get('/health')).headers['x-csrf-token'];
    return agent.post('/auth/login').set('X-CSRF-Token', token).send(credenciales);
  }

  function ultimaFila(where) {
    return prisma.auditLog.findFirst({ where: { ...where, timestamp: { gte: inicio } }, orderBy: { id: 'desc' } });
  }

  beforeAll(async () => {
    const rol = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'consulta' } });
    usuario = await prisma.usuario.upsert({
      where: { email },
      update: { passwordHash: await bcrypt.hash(password, 4) },
      create: { nombre: 'Auditoria Ampliada Test', email, passwordHash: await bcrypt.hash(password, 4), rolId: rol.id },
    });
    inicio = new Date();
  });

  afterAll(() => prisma.$disconnect());

  it('login fallido con correo inexistente deja LOGIN_FALLIDO con email_indice y sin el correo en claro', async () => {
    const inexistente = `no-existe-${Date.now()}@medibox.local`;
    expect((await login({ email: inexistente, password: 'Incorrecta123' })).status).toBe(401);

    const fila = await ultimaFila({ accion: 'LOGIN_FALLIDO', emailIndice: indiceEmail(inexistente) });
    expect(fila).not.toBeNull();
    expect(fila.usuarioId).toBeNull();
    expect(fila.resultado).toBe('fallido');

    const [cruda] = await prisma.$queryRaw`SELECT * FROM audit_log WHERE id = ${fila.id}`;
    const texto = JSON.stringify(cruda, (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') : v));
    expect(texto).not.toContain(inexistente);
    expect(texto).not.toContain('Incorrecta123');
  });

  it('login fallido de una cuenta existente guarda su usuarioId y resultado fallido', async () => {
    expect((await login({ email, password: 'Incorrecta123' })).status).toBe(401);
    const fila = await ultimaFila({ accion: 'LOGIN_FALLIDO', usuarioId: usuario.id });
    expect(fila).toMatchObject({ resultado: 'fallido', entidad: 'Usuario', entidadId: usuario.id });
  });

  it('login exitoso deja LOGIN con la ip de la petición', async () => {
    expect((await login({ email, password })).status).toBe(200);
    const fila = await ultimaFila({ accion: 'LOGIN', usuarioId: usuario.id });
    expect(fila).toMatchObject({ resultado: 'exito', actor: 'usuario' });
    expect(fila.ip).toEqual(expect.stringContaining('127.0.0.1'));
  });

  it('el CSV de auditoría trae actor, resultado e ip', async () => {
    const rolGestor = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'gestor' } });
    const emailGestor = 'auditoria-ampliada-gestor@medibox.local';
    await prisma.usuario.upsert({
      where: { email: emailGestor },
      update: {},
      create: { nombre: 'Gestor Auditoria Ampliada', email: emailGestor, passwordHash: await bcrypt.hash(password, 4), rolId: rolGestor.id },
    });
    const { loginAgent } = require('../helpers/csrf');
    const { agent } = await loginAgent(app, { email: emailGestor, password });
    const res = await agent.get('/datos/exportar/auditoria.csv');
    expect(res.status).toBe(200);
    const [cabecera] = res.text.split(/\r?\n/);
    expect(cabecera.split(',')).toEqual(expect.arrayContaining(['actor', 'resultado', 'ip']));
  });

  it('pasado el límite de intentos responde 429 y deja LOGIN_LIMITADO', async () => {
    let res;
    for (let i = 0; i < 12; i += 1) {
      res = await login({ email, password: 'Incorrecta123' });
      if (res.status === 429) break;
    }
    expect(res.status).toBe(429);
    const fila = await ultimaFila({ accion: 'LOGIN_LIMITADO' });
    expect(fila).toMatchObject({ resultado: 'denegado', usuarioId: null });
    expect(fila.emailIndice).toEqual(indiceEmail(email));
  });
});
