const fs = require('fs');
const os = require('os');
const path = require('path');
const { prisma } = require('../../src/lib/prisma');
const copia = require('../../src/services/auditoriaCopiaService');
const alertas = require('../../src/services/alertasService');

// Copia externa de la auditoría: alterar o borrar una fila del original deja
// rastro. Las pruebas corren con el dueño de la base, que es quien podría
// desactivar el trigger de solo inserción: justo el caso que la copia cubre.
describe('copia externa de la auditoría', () => {
  // Cada prueba copia y verifica la auditoría completa de medibox_test, que
  // crece con cada corrida y no se limpia (es de solo inserción). Con unas 25
  // mil filas una prueba ya roza los 5 s por defecto bajo la suite completa.
  // ponytail: el costo crece con cada corrida, recrear medibox_test si vuelve a acercarse a este límite.
  jest.setTimeout(30000);
  const dirOriginal = process.env.AUDITORIA_COPIA_DIR;
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibox-copia-'));
    process.env.AUDITORIA_COPIA_DIR = dir;
  });

  afterEach(() => {
    process.env.AUDITORIA_COPIA_DIR = dirOriginal;
  });

  afterAll(() => prisma.$disconnect());

  // Como el dueño, con el trigger desactivado solo durante la sentencia.
  async function sinTrigger(sql) {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        'ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_sin_update_ni_delete"',
      ),
      prisma.$executeRawUnsafe(sql),
      prisma.$executeRawUnsafe(
        'ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_sin_update_ni_delete"',
      ),
    ]);
  }

  async function filaVieja() {
    return prisma.auditLog.create({
      data: {
        actor: 'sistema',
        accion: 'RETENCION',
        entidad: 'Sistema',
        entidadId: 0,
        detalle: { anonimizados: 1 },
        timestamp: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
  }

  it('copia la auditoría a archivos de solo lectura y registra el SHA-256 de cada uno', async () => {
    const fila = await filaVieja();
    const r = await copia.copiar({ margenMinutos: 0 });
    expect(r.filas).toBeGreaterThan(0);
    expect(Math.abs(r.desfaseRelojMs)).toBeLessThan(60 * 1000);
    const ultimo = r.archivos[r.archivos.length - 1];
    expect(ultimo).toMatch(/^auditoria_\d+_\d+\.jsonl$/);
    const contenido = r.archivos.map((a) => fs.readFileSync(path.join(dir, a), 'utf8')).join('');
    expect(contenido).toContain(`"id":${fila.id},`);
    const registro = await prisma.auditLog.findFirst({
      where: { accion: 'COPIAR_AUDITORIA', detalle: { path: ['archivo'], equals: ultimo } },
    });
    expect(registro.detalle.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Una segunda corrida solo copia lo nuevo: nunca reescribe un archivo.
    const segunda = await copia.copiar({ margenMinutos: 0 });
    expect(segunda.archivos.every((a) => !r.archivos.includes(a))).toBe(true);
  });

  it('no copia las filas recientes: pueden faltar las de una transacción en curso', async () => {
    const reciente = await prisma.auditLog.create({
      data: { actor: 'sistema', accion: 'RETENCION', entidad: 'Sistema', entidadId: 0 },
    });
    await copia.copiar();
    const copiado = fs
      .readdirSync(dir)
      .map((a) => fs.readFileSync(path.join(dir, a), 'utf8'))
      .join('');
    expect(copiado).not.toContain(`"id":${reciente.id},`);
  });

  it('la verificación pasa si nada cambió, y detecta una fila alterada, una eliminada y una agregada después', async () => {
    const alterada = await filaVieja();
    const eliminada = await filaVieja();
    await copia.copiar({ margenMinutos: 0 });
    expect((await copia.verificar()).hallazgos).toEqual([]);

    await sinTrigger(
      `UPDATE "audit_log" SET "detalle" = '{"anonimizados": 0}' WHERE "id" = ${alterada.id}`,
    );
    await sinTrigger(`DELETE FROM "audit_log" WHERE "id" = ${eliminada.id}`);
    // Una fila insertada a mano con un id ya copiado.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "audit_log" ("id", "actor", "accion", "entidad", "entidad_id", "resultado", "timestamp") VALUES (${eliminada.id}, 'sistema', 'RETENCION', 'Sistema', 0, 'exito', now() - interval '2 hours')`,
    );

    const { hallazgos } = await copia.verificar();
    expect(hallazgos).toEqual(
      expect.arrayContaining([
        { tipo: 'alterada', id: alterada.id },
        { tipo: 'alterada', id: eliminada.id },
      ]),
    );

    await sinTrigger(`DELETE FROM "audit_log" WHERE "id" = ${eliminada.id}`);
    expect((await copia.verificar()).hallazgos).toEqual(
      expect.arrayContaining([{ tipo: 'eliminada', id: eliminada.id }]),
    );
  });

  it('detecta una fila agregada con un id dentro de un tramo ya copiado', async () => {
    const a = await filaVieja();
    const hueco = await filaVieja();
    await sinTrigger(`DELETE FROM "audit_log" WHERE "id" = ${hueco.id}`);
    const b = await filaVieja();
    await copia.copiar({ margenMinutos: 0 });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "audit_log" ("id", "actor", "accion", "entidad", "entidad_id", "resultado", "timestamp") VALUES (${hueco.id}, 'sistema', 'RETENCION', 'Sistema', 0, 'exito', now() - interval '2 hours')`,
    );
    const { hallazgos } = await copia.verificar();
    expect(hallazgos).toEqual(expect.arrayContaining([{ tipo: 'agregada_despues', id: hueco.id }]));
    expect(hallazgos.map((h) => h.id)).not.toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('detecta una copia editada y no confunde la purga de los 15 años con un borrado', async () => {
    const antigua = await prisma.auditLog.create({
      data: {
        actor: 'sistema',
        accion: 'RETENCION',
        entidad: 'Sistema',
        entidadId: 0,
        timestamp: new Date('1990-01-01T00:00:00Z'),
      },
    });
    const { archivos } = await copia.copiar({ margenMinutos: 0 });
    await sinTrigger(`DELETE FROM "audit_log" WHERE "id" = ${antigua.id}`);
    await prisma.auditLog.create({
      data: {
        actor: 'sistema',
        accion: 'PURGAR_AUDITORIA',
        entidad: 'Sistema',
        entidadId: 0,
        detalle: { eliminadas: 1, anteriorA: '2000-01-01T00:00:00.000Z' },
      },
    });
    let r = await copia.verificar();
    expect(r.purgadas).toBeGreaterThanOrEqual(1);
    expect(r.hallazgos.filter((h) => h.id === antigua.id)).toEqual([]);

    const archivo = path.join(dir, archivos[archivos.length - 1]);
    fs.chmodSync(archivo, 0o640);
    fs.writeFileSync(
      archivo,
      fs.readFileSync(archivo, 'utf8').replace('"RETENCION"', '"RETENCI0N"'),
    );
    r = await copia.verificar();
    expect(r.hallazgos).toEqual(
      expect.arrayContaining([{ tipo: 'copia_alterada', archivo: archivos[archivos.length - 1] }]),
    );
  });

  it('una verificación fallida se vuelve una alerta crítica que revisa privacidad', async () => {
    const vieja = await filaVieja();
    await copia.copiar({ margenMinutos: 0 });
    await sinTrigger(`UPDATE "audit_log" SET "entidad_id" = 1 WHERE "id" = ${vieja.id}`);
    const antes = new Date(Date.now() - 1000);
    await copia.verificar();
    const lista = await alertas.detectar({ desde: antes, hasta: new Date() });
    expect(lista.find((a) => a.regla === 'AUDITORIA_ALTERADA')).toEqual(
      expect.objectContaining({ severidad: 'critica', responsable: 'privacidad', plazoHoras: 3 }),
    );
    expect(lista[0].severidad).toBe('critica');
  });
});
