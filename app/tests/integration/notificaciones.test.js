const bcrypt = require('bcrypt');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const notificacionService = require('../../src/services/notificacionService');
const { loginAgent } = require('../helpers/csrf');

describe('Notificaciones', () => {
  let usuario;
  const password = 'Password123!';

  beforeAll(async () => {
    const rol = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'medico' } });
    usuario = await prisma.usuario.upsert({
      where: { email: 'notif-test@medibox.local' },
      update: {},
      create: { nombre: 'Medico Notif', email: 'notif-test@medibox.local', passwordHash: await bcrypt.hash(password, 12), rolId: rol.id },
    });
    await notificacionService.crearNotificacion({ usuarioId: usuario.id, mensaje: 'Nueva cita asignada' });
  });

  afterAll(async () => {
    await prisma.notificacion.deleteMany({ where: { usuarioId: usuario.id } });
    await prisma.usuario.delete({ where: { id: usuario.id } });
    await prisma.$disconnect();
  });

  it('lists notifications for the authenticated user and can mark one as read', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'notif-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    const listRes = await agent.get('/api/notificaciones');
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.length).toBeGreaterThanOrEqual(1);

    const notifId = listRes.body.items[0].id;
    const readRes = await agent.patch(`/api/notificaciones/${notifId}/leida`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.leida).toBe(true);
  });

  it('marks all of a user\'s notifications as read at once', async () => {
    const { agent, loginRes } = await loginAgent(app, { email: 'notif-test@medibox.local', password });
    expect(loginRes.status).toBe(200);

    await notificacionService.crearNotificacion({ usuarioId: usuario.id, mensaje: 'Segunda notificación de prueba' });
    await notificacionService.crearNotificacion({ usuarioId: usuario.id, mensaje: 'Tercera notificación de prueba' });

    const res = await agent.patch('/api/notificaciones/marcar-todas');
    expect(res.status).toBe(204);

    const restantes = await prisma.notificacion.count({ where: { usuarioId: usuario.id, leida: false } });
    expect(restantes).toBe(0);
  });
});
