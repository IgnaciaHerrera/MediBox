const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../lib/prisma');
const { logger } = require('../lib/logger');
const { registrar } = require('./auditService');
const { problemaCopiaAuditoria } = require('../lib/entorno');

// Copia de la auditoría hacia un almacenamiento aparte. El trigger de solo
// inserción impide que la aplicación altere audit_log, pero el dueño de la
// base puede desactivarlo. Con una copia en otro sistema, alterar o borrar
// una fila del original deja rastro: verificar() compara ambas.
//
// AUDITORIA_COPIA_DIR debe apuntar a un montaje de otro equipo (un servidor
// de respaldos o un bucket con retención de objetos) que los administradores
// de la base no puedan escribir. Por omisión queda en registro/, que solo
// sirve para desarrollo.

const LOTE = 5000;
// Solo se copian filas de transacciones que ya terminaron. timestamp es la
// hora en que empezó la transacción que insertó la fila, y el id se asigna
// al insertar: una transacción larga puede confirmar una fila con un id menor
// que otras ya copiadas. Con este margen, toda fila más antigua ya está
// confirmada o descartada.
// ponytail: supone transacciones de menos de 15 minutos (la más larga, la
// rotación de llaves, corta a los 10 y se corre con la app detenida). Si una
// dura más, verificar() la informa como agregada después: es una falsa alarma
// visible, nunca una fila perdida en silencio. Upgrade: copiar desde un
// flujo de replicación lógica en vez de consultar por id.
const MARGEN_MINUTOS = 15;
// Más que esto entre el reloj de la aplicación y el de la base es una señal
// de que un servidor no sincroniza su hora (NTP).
const DESFASE_MAXIMO_MS = 2000;
const NOMBRE = /^auditoria_(\d+)_(\d+)\.jsonl$/;
const SELECT = {
  id: true,
  timestamp: true,
  usuarioId: true,
  actor: true,
  accion: true,
  entidad: true,
  entidadId: true,
  resultado: true,
  ip: true,
  emailIndice: true,
  detalle: true,
};

function directorio() {
  // En producción la copia debe estar en otro equipo: los comandos que copian
  // y verifican (que no pasan por el arranque del servidor) lo comprueban igual.
  const problema = problemaCopiaAuditoria();
  if (problema) throw new Error(problema);
  return (
    process.env.AUDITORIA_COPIA_DIR ||
    path.join(__dirname, '..', '..', 'registro', 'auditoria-copia')
  );
}

/**
 * Una fila de auditoría como línea de la copia, con un orden de campos fijo:
 * la misma fila produce siempre el mismo texto (PostgreSQL normaliza el
 * orden de las claves de un jsonb), así que comparar es comparar textos.
 *
 * @param {object} fila - una fila de audit_log con SELECT.
 * @returns {string} JSON de una línea.
 *
 * Consumidores: copiar(), verificar().
 */
function aLinea(fila) {
  return JSON.stringify({
    id: fila.id,
    timestamp: fila.timestamp.toISOString(),
    usuarioId: fila.usuarioId,
    actor: fila.actor,
    accion: fila.accion,
    entidad: fila.entidad,
    entidadId: fila.entidadId,
    resultado: fila.resultado,
    ip: fila.ip,
    emailIndice: fila.emailIndice ? Buffer.from(fila.emailIndice).toString('hex') : null,
    detalle: fila.detalle ?? null,
  });
}

function archivosCopiados(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((nombre) => {
      const m = NOMBRE.exec(nombre);
      return m ? { nombre, desdeId: Number(m[1]), hastaId: Number(m[2]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.desdeId - b.desdeId);
}

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

/**
 * Copia la auditoría nueva (las filas después de la última copiada, con más
 * de 15 minutos) a archivos JSON Lines de solo lectura, de a 5.000 filas. El
 * SHA-256 de cada archivo queda en la auditoría. Mide además el desfase
 * entre el reloj de la aplicación y el de la base.
 *
 * @param {{ahora?: Date, margenMinutos?: number}} [opciones] - ahora: la hora
 *   de la aplicación; margenMinutos: cuánto esperar a que terminen las
 *   transacciones (15; las pruebas usan 0).
 * @returns {Promise<{archivos: string[], filas: number, desfaseRelojMs: number}>}
 *
 * Consumidores: src/auditoria-copiar.js (npm run auditoria:copiar).
 */
async function copiar({ ahora = new Date(), margenMinutos = MARGEN_MINUTOS } = {}) {
  const dir = directorio();
  fs.mkdirSync(dir, { recursive: true });
  const [{ ahoraBase }] = await prisma.$queryRaw`SELECT now() AS "ahoraBase"`;
  const desfaseRelojMs = ahora.getTime() - ahoraBase.getTime();
  if (Math.abs(desfaseRelojMs) > DESFASE_MAXIMO_MS)
    logger.warn(
      { desfaseRelojMs },
      'El reloj de la aplicación y el de la base no coinciden: revisa NTP',
    );
  const limite = new Date(ahoraBase.getTime() - margenMinutos * 60 * 1000);
  // Reciente: pudo insertarla una transacción que terminó hace poco. Una
  // fila con hora futura no se explica por una transacción en curso sino por
  // un reloj adelantado: se copia, y se avisa.
  const reciente = (f) => f.timestamp >= limite && f.timestamp <= ahoraBase;

  const copiados = archivosCopiados(dir);
  let ultimo = copiados.length > 0 ? copiados[copiados.length - 1].hastaId : 0;
  const archivos = [];
  let filas = 0;
  for (;;) {
    const lote = await prisma.auditLog.findMany({
      where: { id: { gt: ultimo } },
      orderBy: { id: 'asc' },
      take: LOTE,
      select: SELECT,
    });
    // Se copia hasta la primera fila demasiado reciente, sin saltarla.
    const corte = lote.findIndex(reciente);
    const futuras = lote.filter((f) => f.timestamp > ahoraBase).length;
    if (futuras > 0)
      logger.warn(
        { futuras },
        'Hay filas de auditoría con hora futura: revisa el reloj de la base',
      );
    const listas = corte === -1 ? lote : lote.slice(0, corte);
    if (listas.length === 0) break;
    const contenido = `${listas.map(aLinea).join('\n')}\n`;
    const nombre = `auditoria_${listas[0].id}_${listas[listas.length - 1].id}.jsonl`;
    // wx: nunca sobrescribe una copia anterior; 0o440: solo lectura.
    fs.writeFileSync(path.join(dir, nombre), contenido, { flag: 'wx', mode: 0o440 });
    await registrar({
      actor: 'sistema',
      accion: 'COPIAR_AUDITORIA',
      entidad: 'Sistema',
      entidadId: 0,
      detalle: {
        archivo: nombre,
        filas: listas.length,
        desdeId: listas[0].id,
        hastaId: listas[listas.length - 1].id,
        sha256: sha256(contenido),
        desfaseRelojMs,
      },
    });
    archivos.push(nombre);
    filas += listas.length;
    ultimo = listas[listas.length - 1].id;
    if (corte !== -1 || lote.length < LOTE) break;
  }
  return { archivos, filas, desfaseRelojMs };
}

/**
 * Compara la auditoría de la base con su copia. Informa:
 *   - eliminada: está en la copia y no en la base (y no la borró la purga de
 *     los 15 años);
 *   - alterada: está en ambas, con otro contenido;
 *   - agregada_despues: está en la base, dentro de un tramo ya copiado, y no
 *     en la copia (una fila insertada con un id antiguo);
 *   - copia_alterada: el archivo no tiene el SHA-256 que se registró al
 *     copiarlo;
 *   - sin_registro: no hay registro de haber copiado ese archivo (se borró
 *     de la base o el archivo no salió de MediBox).
 *
 * @returns {Promise<{archivos: number, filas: number, purgadas: number,
 *   hallazgos: Array<{tipo: string, id?: number, archivo?: string}>}>}
 *
 * Consumidores: src/auditoria-verificar.js (npm run auditoria:verificar).
 */
async function verificar() {
  const dir = directorio();
  const copiados = archivosCopiados(dir);
  const registrosCopia = await prisma.auditLog.findMany({
    where: { accion: 'COPIAR_AUDITORIA' },
    select: { detalle: true },
  });
  const shaRegistrado = new Map(registrosCopia.map((r) => [r.detalle.archivo, r.detalle.sha256]));
  const purgas = await prisma.auditLog.findMany({
    where: { accion: 'PURGAR_AUDITORIA' },
    select: { detalle: true },
  });
  const purgadoAntesDe = purgas.reduce(
    (max, p) => Math.max(max, new Date(p.detalle.anteriorA).getTime()),
    0,
  );

  const hallazgos = [];
  let filas = 0;
  let purgadas = 0;
  for (const archivo of copiados) {
    const contenido = fs.readFileSync(path.join(dir, archivo.nombre), 'utf8');
    if (!shaRegistrado.has(archivo.nombre))
      hallazgos.push({ tipo: 'sin_registro', archivo: archivo.nombre });
    else if (shaRegistrado.get(archivo.nombre) !== sha256(contenido))
      hallazgos.push({ tipo: 'copia_alterada', archivo: archivo.nombre });

    const lineas = contenido.split('\n').filter(Boolean);
    const enBase = new Map(
      (
        await prisma.auditLog.findMany({
          where: { id: { gte: archivo.desdeId, lte: archivo.hastaId } },
          select: SELECT,
        })
      ).map((f) => [f.id, aLinea(f)]),
    );
    for (const linea of lineas) {
      filas += 1;
      const copia = JSON.parse(linea);
      const actual = enBase.get(copia.id);
      enBase.delete(copia.id);
      if (actual === undefined) {
        if (new Date(copia.timestamp).getTime() < purgadoAntesDe) purgadas += 1;
        else hallazgos.push({ tipo: 'eliminada', id: copia.id });
      } else if (actual !== linea) {
        hallazgos.push({ tipo: 'alterada', id: copia.id });
      }
    }
    for (const id of enBase.keys()) hallazgos.push({ tipo: 'agregada_despues', id });
  }

  const porTipo = {};
  hallazgos.forEach((h) => (porTipo[h.tipo] = (porTipo[h.tipo] || 0) + 1));
  const primeros = hallazgos
    .filter((h) => h.id)
    .slice(0, 10)
    .map((h) => h.id);
  await registrar({
    actor: 'sistema',
    accion: 'VERIFICAR_AUDITORIA',
    entidad: 'Sistema',
    entidadId: 0,
    resultado: hallazgos.length === 0 ? 'exito' : 'fallido',
    detalle: {
      archivos: copiados.length,
      filas,
      purgadas,
      hallazgos: porTipo,
      primerosIds: primeros,
    },
  });
  return { archivos: copiados.length, filas, purgadas, hallazgos };
}

module.exports = { copiar, verificar, MARGEN_MINUTOS, DESFASE_MAXIMO_MS };
