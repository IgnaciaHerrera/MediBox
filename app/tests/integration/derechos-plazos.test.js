const { prisma } = require('../../src/lib/prisma');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const canalEnvio = require('../../src/lib/canalEnvio');
const { aJson } = require('../../src/lib/archivoTitular');
const derechos = require('../../src/services/derechosService');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// Ciclo de vida de una solicitud según la Ley 21.719, art. 11: acuse de
// recibo con número de seguimiento, plazos (30 días corridos prorrogables una
// vez; bloqueo en 2 días hábiles), resultado parcial con aviso de reclamo,
// avisos de vencimiento y entrega a distancia por el portal.
describe('Solicitudes de derechos: plazos, resultado y entrega', () => {
  const password = 'Password123!';
  let operador;
  let privacidad;
  let gestorPrivacidad;
  const pacientes = {};

  beforeAll(async () => {
    operador = await usuarioDePrueba('plazos-operador@medibox.local', 'operador', password);
    privacidad = await usuarioDePrueba('plazos-privacidad@medibox.local', 'privacidad', password);
    gestorPrivacidad = { id: privacidad.id, permisos: ['derechos.gestionar'] };
    let n = 0;
    for (const clave of ['acuse', 'sinContacto', 'prorroga', 'supresion', 'rechazo', 'rectificacion', 'entrega', 'vencida']) {
      n += 1;
      pacientes[clave] = await pacienteDePrueba({
        nombre: `Plazos ${clave}`,
        contacto: clave === 'sinContacto' ? undefined : `plazos-${n}@correo.test`,
        createdAt: haceHoras(72),
      });
    }
  });

  afterAll(async () => {
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  const contactoDe = (clave) => `plazos-${Object.keys(pacientes).indexOf(clave) + 1}@correo.test`;

  describe('vencimiento', () => {
    it('30 días corridos para todo, salvo el bloqueo: 2 días hábiles', () => {
      const viernes = new Date('2026-10-30T10:00:00');
      expect(derechos.calcularVencimiento('acceso', viernes).toISOString()).toBe(new Date('2026-11-29T10:00:00').toISOString());
      // Viernes + 2 días hábiles = martes (no cuenta el fin de semana).
      expect(derechos.calcularVencimiento('bloqueo', viernes).getDay()).toBe(2);
      expect(derechos.calcularVencimiento('bloqueo', new Date('2026-10-26T10:00:00')).getDate()).toBe(28);
    });
  });

  describe('acuse de recibo', () => {
    it('se envía al contacto registrado con el número de seguimiento y el vencimiento', async () => {
      const solicitud = await solicitudDePrueba(pacientes.acuse, operador, { derecho: 'acceso' });
      const { mensaje } = canalEnvio.ultimo(contactoDe('acuse'));
      expect(mensaje).toContain(`número ${solicitud.id}`);
      expect(mensaje).toContain('Si usted no la presentó');
      expect(mensaje).not.toContain('Plazos acuse');
    });

    it('sin contacto la solicitud igual queda registrada, sin acuse', async () => {
      const res = await derechos.registrarSolicitud({ pacienteId: pacientes.sinContacto.id, derecho: 'acceso', canal: 'presencial' }, { id: operador.id, permisos: ['paciente.read', 'derechos.registrar'] });
      expect(res).toMatchObject({ acuse: false });
      expect(res.id).toBeDefined();
    });
  });

  describe('prórroga', () => {
    let solicitud;

    beforeAll(async () => {
      solicitud = await solicitudDePrueba(pacientes.prorroga, operador, { derecho: 'acceso' });
    });

    it('exige motivo y no supera los 30 días', async () => {
      await expect(derechos.prorrogar(solicitud.id, gestorPrivacidad, { dias: 10 })).rejects.toMatchObject({ statusCode: 400 });
      await expect(derechos.prorrogar(solicitud.id, gestorPrivacidad, { dias: 31, motivo: 'Hay que reunir antecedentes' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('se prorroga una sola vez; el motivo queda cifrado y no viaja en el aviso', async () => {
      const { venceEl } = await derechos.prorrogar(solicitud.id, gestorPrivacidad, { dias: 30, motivo: 'Hay que reunir antecedentes del archivo' });
      expect(venceEl.getTime()).toBe(solicitud.venceEl.getTime() + 30 * 24 * 60 * 60 * 1000);
      const fila = await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } });
      expect(fila.prorrogadaEl).toBeInstanceOf(Date);
      expect(Buffer.from(fila.prorrogaMotivoCifrado).toString('latin1')).not.toContain('antecedentes');
      expect(canalEnvio.ultimo(contactoDe('prorroga')).mensaje).not.toContain('antecedentes');
      await expect(derechos.prorrogar(solicitud.id, gestorPrivacidad, { dias: 5, motivo: 'Otra vez más, por favor' })).rejects.toMatchObject({ statusCode: 409 });
      const auditada = await prisma.auditLog.findFirst({ where: { accion: 'PRORROGAR_DERECHO', entidadId: pacientes.prorroga.id } });
      expect(auditada.detalle).toEqual({ solicitudId: solicitud.id, dias: 30 });
    });

    it('un bloqueo no se prorroga', async () => {
      const bloqueo = await solicitudDePrueba(pacientes.prorroga, operador, { derecho: 'bloqueo' });
      await expect(derechos.prorrogar(bloqueo.id, gestorPrivacidad, { dias: 5, motivo: 'Necesitamos más tiempo' })).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('resultado y fechas de cada paso', () => {
    it('la supresión se cierra como atendida en parte, con el aviso de reclamo ante la Agencia', async () => {
      const solicitud = await solicitudDePrueba(pacientes.supresion, operador, { derecho: 'supresion' }, { metodo: 'cedula' });
      expect(solicitud.verificadaEl).toBeInstanceOf(Date);
      await derechos.ejecutar(solicitud.id, gestorPrivacidad, { respuesta: 'Se eliminó su contacto; lo clínico se conserva bloqueado.' });
      const [fila] = (await derechos.armarArchivoTitular(pacientes.supresion.id)).solicitudes.filter((s) => s.numero === solicitud.id);
      expect(fila).toMatchObject({ estado: 'resuelta', resultado: 'parcial' });
      expect(fila.respuesta).toContain(derechos.AVISO_RECLAMO);
    });

    it('un rechazo también lleva el aviso; una rectificación atendida, no', async () => {
      const rechazo = await solicitudDePrueba(pacientes.rechazo, operador, { derecho: 'oposicion', finalidadClave: 'encuestas' }, { metodo: 'cedula' });
      await derechos.rechazar(rechazo.id, gestorPrivacidad, { respuesta: 'No tenía ese consentimiento.' });
      const rect = await solicitudDePrueba(pacientes.rectificacion, operador, { derecho: 'rectificacion', campo: 'nombre', valorPropuesto: 'Plazos Corregido' }, { metodo: 'cedula' });
      await derechos.ejecutar(rect.id, gestorPrivacidad, { respuesta: 'Corregimos su nombre.' });

      const filas = await prisma.solicitudDerecho.findMany({ where: { id: { in: [rechazo.id, rect.id] } }, orderBy: { id: 'asc' } });
      expect(filas.map((f) => f.resultado)).toEqual(['rechazada', 'atendida']);
      const archivo = await derechos.armarArchivoTitular(pacientes.rectificacion.id);
      expect(archivo.solicitudes.find((s) => s.numero === rect.id).respuesta).not.toContain('Agencia');
      // El cambio muestra el valor anterior y el nuevo, aunque solo se guarda el anterior.
      expect(archivo.historialCambios.find((h) => h.campo === 'nombre')).toMatchObject({ valorAnterior: 'Plazos rectificacion', valorNuevo: 'Plazos Corregido' });
    });
  });

  describe('avisos de vencimiento', () => {
    it('cuenta vencidas y por vencer y avisa a privacidad sin nombrar a nadie', async () => {
      const vencida = await solicitudDePrueba(pacientes.vencida, operador, { derecho: 'acceso' });
      const porVencer = await solicitudDePrueba(pacientes.vencida, operador, { derecho: 'rectificacion', campo: 'nombre', valorPropuesto: 'Otro Nombre' });
      await prisma.solicitudDerecho.update({ where: { id: vencida.id }, data: { venceEl: haceHoras(5) } });
      await prisma.solicitudDerecho.update({ where: { id: porVencer.id }, data: { venceEl: new Date(Date.now() + 24 * 60 * 60 * 1000) } });

      const resumen = await derechos.avisarVencimientos();
      expect(resumen.vencidas).toBeGreaterThanOrEqual(1);
      expect(resumen.porVencer).toBeGreaterThanOrEqual(1);
      const aviso = await prisma.notificacion.findFirst({ where: { usuarioId: privacidad.id }, orderBy: { id: 'desc' } });
      expect(aviso.mensaje).toMatch(/vencida/);
      expect(aviso.mensaje).not.toContain('Plazos vencida');

      const lista = await derechos.listarPendientes({ id: privacidad.id });
      expect(lista.find((s) => s.id === porVencer.id)).toMatchObject({ porVencer: true, dentroDePlazo: true });
      expect(lista.find((s) => s.id === vencida.id)).toMatchObject({ porVencer: false, dentroDePlazo: false });
    });
  });

  describe('entrega del archivo', () => {
    it('a distancia no genera el archivo: avisa al contacto que lo descargue en el portal', async () => {
      const solicitud = await solicitudDePrueba(pacientes.entrega, operador, { derecho: 'portabilidad' }, { metodo: 'cedula' });
      const archivo = await derechos.exportarDatosTitular(solicitud.id, gestorPrivacidad, { entrega: 'contacto_registrado', formato: 'json' });
      expect(archivo).toBeNull();
      expect(canalEnvio.ultimo(contactoDe('entrega')).mensaje).toContain('portal del paciente');
      expect(await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).toMatchObject({ estado: 'resuelta', resultado: 'atendida', entrega: 'contacto_registrado' });
      const acciones = (await prisma.auditLog.findMany({ where: { entidadId: pacientes.entrega.id, accion: { in: ['AVISAR_ENTREGA', 'EXPORT_TITULAR'] } } })).map((a) => a.accion);
      expect(acciones).toEqual(['AVISAR_ENTREGA']);
    });

    it('el JSON es legible por una máquina, trae el origen de cada dato y ningún id interno', async () => {
      const archivo = await derechos.armarArchivoTitular(pacientes.entrega.id);
      const json = JSON.parse(aJson(archivo).toString('utf8'));
      expect(json).toMatchObject({ formato: 'medibox-titular', version: 1, titular: { nombre: 'Plazos entrega' } });
      expect(json.tratamiento.datos.every((d) => typeof d.origen === 'string' && d.origen.length > 10)).toBe(true);
      const texto = JSON.stringify(json);
      expect(texto).not.toMatch(/"(pacienteId|usuarioId|verificacionId|rutIndice|codigoHash)"/);
      expect(json.solicitudes[0].numero).toBeDefined();
    });
  });

});
