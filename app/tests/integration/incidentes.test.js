const crypto = require('crypto');
const fs = require('fs');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba } = require('../helpers/datos');
const { cambiarSuspension } = require('../../src/services/usuarioService');
const { purgarVencidos, registrar } = require('../../src/services/auditService');
const incidentes = require('../../src/services/incidenteService');

// Procedimientos técnicos del plan de respuesta a incidentes: suspender una
// cuenta comprometida, preservar la evidencia antes de contener, purgar la
// auditoría que cumplió 15 años y llevar el registro de incidentes (Ley
// 21.719, art. 14 sexies).
describe('Respuesta a incidentes', () => {
  const password = 'Password123!';
  let gestor;
  let comprometida;
  let agenteGestor;

  beforeAll(async () => {
    gestor = await usuarioDePrueba('incidentes-gestor@medibox.local', 'gestor', password);
    comprometida = await usuarioDePrueba('incidentes-comprometida@medibox.local', 'operador', password);
    await prisma.usuario.update({ where: { id: comprometida.id }, data: { suspendida: false, suspendidaEl: null } });
    ({ agent: agenteGestor } = await loginAgent(app, { email: gestor.email, password }));
  });

  afterAll(async () => {
    await prisma.usuario.update({ where: { id: comprometida.id }, data: { suspendida: false, suspendidaEl: null } });
    await prisma.$disconnect();
  });

  describe('suspender una cuenta comprometida', () => {
    it('corta la sesión abierta y no deja volver a entrar, ni con la contraseña correcta', async () => {
      const { agent: robada } = await loginAgent(app, { email: comprometida.email, password });
      expect((await robada.get('/api/notificaciones')).status).toBe(200);

      const { cerradas } = await cambiarSuspension(comprometida.id, true, { actor: 'sistema' });
      expect(cerradas).toBeGreaterThanOrEqual(1);
      expect((await robada.get('/api/notificaciones')).status).toBe(401);
      const { loginRes } = await loginAgent(app, { email: comprometida.email, password });
      expect(loginRes.status).toBe(401);

      const fila = await prisma.auditLog.findFirst({ where: { accion: 'SUSPENDER_CUENTA', entidadId: comprometida.id }, orderBy: { id: 'desc' } });
      expect(fila.actor).toBe('sistema');
    });

    it('reactivada, vuelve a entrar', async () => {
      await cambiarSuspension(comprometida.id, false, { actor: 'sistema' });
      const { loginRes } = await loginAgent(app, { email: comprometida.email, password });
      expect(loginRes.status).toBe(200);
    });
  });

  describe('preservar la evidencia', () => {
    it('copia la auditoría de la ventana fuera de la base y deja su SHA-256 en la auditoría', async () => {
      const desde = new Date(Date.now() - 60 * 1000);
      await registrar({ usuarioId: comprometida.id, accion: 'READ', entidad: 'Paciente', entidadId: 0, detalle: { motivo: 'prueba-evidencia' } });
      const r = await incidentes.preservarEvidencia({ desde, hasta: new Date(), usuarioId: comprometida.id });

      const contenido = fs.readFileSync(r.archivo, 'utf8');
      expect(crypto.createHash('sha256').update(contenido).digest('hex')).toBe(r.sha256);
      const lineas = contenido.trim().split('\n').map((l) => JSON.parse(l));
      expect(lineas[0]).toMatchObject({ tipo: 'evidencia', usuarioId: comprometida.id });
      expect(lineas.filter((l) => l.tipo === 'auditoria')).toHaveLength(r.filas);
      expect(lineas.some((l) => l.tipo === 'auditoria' && l.detalle && l.detalle.motivo === 'prueba-evidencia')).toBe(true);
      // De las sesiones, solo el hash del identificador.
      lineas.filter((l) => l.tipo === 'sesion').forEach((l) => expect(Object.keys(l).sort()).toEqual(['expire', 'sidSha256', 'tipo']));

      const auditada = await prisma.auditLog.findFirst({ where: { accion: 'PRESERVAR_EVIDENCIA' }, orderBy: { id: 'desc' } });
      expect(auditada.detalle).toMatchObject({ sha256: r.sha256, filas: r.filas });
    });
  });

  describe('conservación de la auditoría', () => {
    it('elimina solo lo que cumplió 15 años; lo demás sigue sin poder borrarse ni editarse', async () => {
      const vieja = new Date();
      vieja.setFullYear(vieja.getFullYear() - 16);
      const { id: idVieja } = await prisma.auditLog.create({ data: { actor: 'sistema', accion: 'PRUEBA_PURGA', entidad: 'Sistema', entidadId: 0, timestamp: vieja } });
      const { id: idNueva } = await prisma.auditLog.create({ data: { actor: 'sistema', accion: 'PRUEBA_PURGA', entidad: 'Sistema', entidadId: 0 } });

      const { eliminadas } = await purgarVencidos();
      expect(eliminadas).toBeGreaterThanOrEqual(1);
      expect(await prisma.auditLog.findUnique({ where: { id: idVieja } })).toBeNull();
      expect(await prisma.auditLog.findUnique({ where: { id: idNueva } })).not.toBeNull();

      await expect(prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${idNueva}`).rejects.toThrow(/solo inserción/);
      await expect(prisma.$executeRaw`UPDATE audit_log SET timestamp = ${vieja} WHERE id = ${idNueva}`).rejects.toThrow(/solo inserción/);
      const constancia = await prisma.auditLog.findFirst({ where: { accion: 'PURGAR_AUDITORIA' }, orderBy: { id: 'desc' } });
      expect(constancia.detalle.eliminadas).toBe(eliminadas);
    });
  });

  describe('registro de incidentes', () => {
    const base = { titulo: 'Volumen anómalo de lecturas', origen: 'alerta_automatica', severidad: 'alta', dimension: 'confidencialidad', descripcion: 'Una cuenta de operador leyó 36 fichas en una hora.' };
    let id;

    it('quien no lleva el registro no lo ve', async () => {
      const { agent } = await loginAgent(app, { email: comprometida.email, password });
      expect((await agent.get('/incidentes')).status).toBe(403);
    });

    it('se registra como alerta y no se puede saltar al estado confirmado', async () => {
      const res = await agenteGestor.post('/incidentes').send(base);
      expect(res.status).toBe(200);
      ({ id } = res.body);
      expect((await prisma.incidente.findUnique({ where: { id } })).estado).toBe('alerta');
      expect((await agenteGestor.post(`/incidentes/${id}/estado`).send({ estado: 'confirmado' })).status).toBe(409);
    });

    it('se confirma, y no se cierra sin medidas, lecciones ni la decisión sobre la notificación', async () => {
      await incidentes.cambiarEstado(id, 'sospechoso', gestor);
      await incidentes.cambiarEstado(id, 'confirmado', gestor);
      await expect(incidentes.cambiarEstado(id, 'cerrado', gestor)).rejects.toMatchObject({ statusCode: 409 });

      // Afecta datos de salud: notificar a la Agencia obliga también a comunicarlo a los titulares.
      await agenteGestor.post(`/incidentes/${id}`).send({
        ...base,
        categoriasDatos: ['identidad', 'salud'],
        titularesAfectados: 36,
        medidas: 'Se suspendió la cuenta y se rotó SESSION_SECRET.',
        lecciones: 'La detección dependía de una sola regla; se agregó la suspensión de cuentas.',
        notificadoAgenciaEl: '2026-10-30T12:00',
      });
      await expect(incidentes.cambiarEstado(id, 'cerrado', gestor)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('titulares') });
    });

    it('con la comunicación a los titulares se cierra; cerrado ya no se edita y cada cambio queda auditado', async () => {
      const actual = await prisma.incidente.findUnique({ where: { id } });
      await incidentes.actualizarIncidente(id, { ...base, categoriasDatos: actual.categoriasDatos, medidas: actual.medidas, lecciones: actual.lecciones, notificadoAgenciaEl: actual.notificadoAgenciaEl, notificadoTitularesEl: '2026-10-30T15:00' }, gestor);
      await incidentes.cambiarEstado(id, 'cerrado', gestor);
      expect((await prisma.incidente.findUnique({ where: { id } })).cerradoEl).toBeInstanceOf(Date);
      await expect(incidentes.actualizarIncidente(id, base, gestor)).rejects.toMatchObject({ statusCode: 409 });

      const cambios = await prisma.auditLog.findMany({ where: { entidad: 'Incidente', entidadId: id, accion: 'CAMBIAR_ESTADO_INCIDENTE' }, orderBy: { id: 'asc' } });
      expect(cambios.map((c) => c.detalle.a)).toEqual(['sospechoso', 'confirmado', 'cerrado']);
    });

    it('el borrador de la notificación trae los siete contenidos mínimos', async () => {
      const { borrador, exigeNotificarTitulares } = await incidentes.obtener(id);
      expect(exigeNotificarTitulares).toBe(true);
      for (let n = 1; n <= 7; n += 1) expect(borrador).toContain(`${n}. `);
      expect(borrador).toContain('36');
      expect(borrador).toContain('salud');
    });

    it('una alerta se puede descartar como falso positivo', async () => {
      const { id: otro } = await incidentes.registrarIncidente({ ...base, titulo: 'Ubicación inusual del gestor' }, gestor);
      await incidentes.cambiarEstado(otro, 'descartado', gestor);
      await expect(incidentes.cambiarEstado(otro, 'sospechoso', gestor)).rejects.toMatchObject({ statusCode: 409 });
    });
  });
});
