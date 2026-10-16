const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const canalEnvio = require('../../src/lib/canalEnvio');
const { pacienteDePrueba, rutAleatorio } = require('../helpers/datos');
const { limpiarPacientes } = require('../helpers/derechos');
const { rutDe, agentePortal } = require('../helpers/portal');
const portalService = require('../../src/services/portalService');
const pacienteService = require('../../src/services/pacienteService');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// Ingreso al portal del titular: RUT + código de un solo uso al contacto
// registrado, sin cuentas. Lo que no debe pasar: enumerar RUT, mandar el
// código a un contacto recién cambiado, superar los intentos o que una
// sesión del portal abra las rutas del personal. Cada archivo de pruebas
// tiene su propio límite por IP (5 pedidos de código en 15 minutos).
describe('Portal del titular: ingreso', () => {
  const pacientes = {};

  beforeAll(async () => {
    pacientes.conContacto = await pacienteDePrueba({ nombre: 'Portal Ingreso', contacto: '+56977100001', createdAt: haceHoras(72) });
    pacientes.sinContacto = await pacienteDePrueba({ nombre: 'Portal Sin Contacto', createdAt: haceHoras(72) });
    pacientes.contactoNuevo = await pacienteDePrueba({ nombre: 'Portal Contacto Nuevo', contacto: '+56977100003', createdAt: haceHoras(2) });
    pacientes.tope = await pacienteDePrueba({ nombre: 'Portal Tope', contacto: '+56977100004', createdAt: haceHoras(72) });
    pacientes.bloqueado = await pacienteDePrueba({ nombre: 'Portal Bloqueado', contacto: '+56977100005', createdAt: haceHoras(72) });
    pacientes.intentos = await pacienteDePrueba({ nombre: 'Portal Intentos', contacto: '+56977100006', createdAt: haceHoras(72) });
    await prisma.paciente.update({ where: { id: pacientes.bloqueado.id }, data: { bloqueado: true } });
  });

  afterAll(async () => {
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('responde lo mismo exista o no el RUT, y solo envía el código a quien tiene contacto', async () => {
    const respuestas = [];
    for (const rut of [rutDe(pacientes.conContacto), rutAleatorio(), rutDe(pacientes.sinContacto)]) {
      const agent = await agentePortal(app);
      const res = await agent.post('/portal/ingresar').send({ rut });
      respuestas.push({ status: res.status, body: res.body });
    }
    expect(respuestas.every((r) => r.status === 200)).toBe(true);
    expect(new Set(respuestas.map((r) => JSON.stringify(r.body))).size).toBe(1);

    const mensaje = canalEnvio.ultimo('+56977100001');
    expect(mensaje.mensaje).toMatch(/portal del paciente es \d{6}/);
    // El código no aparece en la respuesta ni en la auditoría.
    const codigo = mensaje.mensaje.match(/\b(\d{6})\b/)[1];
    expect(JSON.stringify(respuestas)).not.toContain(codigo);
    const filas = await prisma.auditLog.findMany({ where: { entidad: 'Paciente', entidadId: pacientes.conContacto.id } });
    expect(JSON.stringify(filas)).not.toContain(codigo);
    expect(filas.find((f) => f.accion === 'PORTAL_CODIGO')).toMatchObject({ actor: 'portal', usuarioId: null });
  });

  it('con el código correcto abre una sesión del titular que no sirve para las rutas del personal', async () => {
    const agent = await agentePortal(app);
    await agent.post('/portal/ingresar').send({ rut: rutDe(pacientes.conContacto) });
    const codigo = canalEnvio.ultimo('+56977100001').mensaje.match(/\b(\d{6})\b/)[1];
    const otro = codigo === '000000' ? '111111' : '000000';

    expect((await agent.post('/portal/confirmar').send({ codigo: otro })).status).toBe(400);
    expect((await agent.get('/portal/mis-datos')).status).toBe(401);
    const ok = await agent.post('/portal/confirmar').send({ codigo });
    expect(ok.status).toBe(200);
    agent.token = ok.headers['x-csrf-token'];
    // De un solo uso.
    expect((await agent.post('/portal/confirmar').send({ codigo })).status).toBe(400);

    const datos = await agent.get('/portal/mis-datos');
    expect(datos.status).toBe(200);
    expect(datos.headers['cache-control']).toBe('no-store');
    expect(datos.body.titular.nombre).toBe('Portal Ingreso');

    expect((await agent.get('/api/pacientes')).status).toBe(401);
    expect((await agent.get(`/api/pacientes/${pacientes.conContacto.id}`)).status).toBe(401);
    expect((await agent.get('/solicitudes')).status).toBe(401);

    const ingreso = await prisma.auditLog.findFirst({ where: { accion: 'PORTAL_INGRESO', entidadId: pacientes.conContacto.id } });
    expect(ingreso).toMatchObject({ actor: 'titular', usuarioId: null });
    const fallido = await prisma.auditLog.findFirst({ where: { accion: 'VERIFICAR_IDENTIDAD', entidadId: pacientes.conContacto.id, resultado: 'fallido' } });
    expect(fallido).toMatchObject({ actor: 'portal', detalle: { metodo: 'codigo_portal' } });
  });

  it('no envía el código a un contacto registrado hace menos de 24 horas', async () => {
    const agent = await agentePortal(app);
    expect((await agent.post('/portal/ingresar').send({ rut: rutDe(pacientes.contactoNuevo) })).status).toBe(200);
    expect(canalEnvio.ultimo('+56977100003')).toBeUndefined();
  });

  it('no envía más de 3 códigos por hora al mismo paciente ni ninguno a un paciente bloqueado', async () => {
    const rut = rutDe(pacientes.tope);
    const enviados = [];
    for (let i = 0; i < 5; i += 1) enviados.push((await portalService.solicitarIngreso(rut)).verificacionId);
    expect(enviados.filter(Boolean)).toHaveLength(portalService.ENVIOS_POR_HORA);
    expect(await prisma.auditLog.count({ where: { accion: 'PORTAL_CODIGO', entidadId: pacientes.tope.id, resultado: 'denegado' } })).toBe(2);

    expect((await portalService.solicitarIngreso(rutDe(pacientes.bloqueado))).verificacionId).toBeNull();
    expect(canalEnvio.ultimo('+56977100005')).toBeUndefined();
  });

  it('acepta un RUT con la forma correcta aunque su dígito no calce, y rechaza lo que no es un RUT', async () => {
    // La búsqueda es exacta por el índice ciego: un dígito mal registrado no
    // deja fuera al titular, y un RUT inexistente no envía nada.
    expect((await portalService.solicitarIngreso('12.345.678-0')).verificacionId).toBeNull();
    await expect(portalService.solicitarIngreso('<script>')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('agotados los 5 intentos, ni el código correcto sirve', async () => {
    const { verificacionId } = await portalService.solicitarIngreso(rutDe(pacientes.intentos));
    const codigo = canalEnvio.ultimo('+56977100006').mensaje.match(/\b(\d{6})\b/)[1];
    const otro = codigo === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await expect(portalService.confirmarIngreso(verificacionId, otro)).rejects.toMatchObject({ statusCode: 400 });
    await expect(portalService.confirmarIngreso(verificacionId, codigo)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('la sesión del portal vence a los 15 minutos y se corta si el paciente se bloquea', async () => {
    const id = pacientes.conContacto.id;
    expect(await portalService.sesionVigente({ pacienteId: id, verificacionId: 1, expiraEl: Date.now() + 60000 })).not.toBeNull();
    expect(await portalService.sesionVigente({ pacienteId: id, verificacionId: 1, expiraEl: Date.now() - 1 })).toBeNull();
    expect(await portalService.sesionVigente({ pacienteId: pacientes.bloqueado.id, verificacionId: 1, expiraEl: Date.now() + 60000 })).toBeNull();
    expect(await pacienteService.estaBloqueado(id)).toBe(false);
  });

  it('limita los pedidos de código por IP y lo deja en la auditoría', async () => {
    const agent = await agentePortal(app);
    // Ya se usaron 5 pedidos en este archivo: el siguiente se rechaza.
    const res = await agent.post('/portal/ingresar').send({ rut: rutAleatorio() });
    expect(res.status).toBe(429);
    expect(await prisma.auditLog.count({ where: { accion: 'PORTAL_LIMITADO', timestamp: { gte: new Date(Date.now() - 60000) } } })).toBeGreaterThan(0);
  });
});
