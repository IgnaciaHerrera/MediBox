const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const { ingresarAlPortal } = require('../helpers/portal');
const { comoBinario } = require('../helpers/archivo');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);
const comoTexto = (cuerpo) => cuerpo.toString('latin1');

// El archivo del titular concentra sus datos de salud: un PDF suelto en una
// carpeta o un USB lo abre cualquiera. Se protege con una contraseña que elige
// el propio titular al pedirlo; no se guarda, no se registra y el servidor no la
// recupera. (JSON y Excel no se cifran: ver README.)
describe('PDF del titular protegido con contraseña', () => {
  const password = 'Password123!';
  const clave = 'clave-del-titular-2026';
  let operador;
  let privacidad;
  let agente;
  let titular;
  let portal;

  const reautenticar = () => agente.post('/solicitudes/reautenticar').send({ password });
  const portabilidades = () => prisma.solicitudDerecho.count({ where: { pacienteId: titular.id, derecho: 'portabilidad' } });
  const solicitudNueva = () => solicitudDePrueba(titular, operador, { derecho: 'portabilidad' }, { metodo: 'cedula' });

  beforeAll(async () => {
    operador = await usuarioDePrueba('pdf-clave-operador@medibox.local', 'operador', password);
    privacidad = await usuarioDePrueba('pdf-clave-privacidad@medibox.local', 'privacidad', password);
    ({ agent: agente } = await loginAgent(app, { email: privacidad.email, password }));
    titular = await pacienteDePrueba({ nombre: 'Titular Con Clave', contacto: '+56979100001', createdAt: haceHoras(72) });
    portal = await ingresarAlPortal(app, titular, '+56979100001');
  });

  afterAll(async () => {
    await limpiarPacientes([titular.id]);
    await prisma.$disconnect();
  });

  describe('en el portal', () => {
    it('sin contraseña, o con una demasiado corta, no genera nada ni deja una portabilidad', async () => {
      const antes = await portabilidades();
      const sin = await portal.post('/portal/descargar').send({ formato: 'pdf' });
      const corta = await portal.post('/portal/descargar').send({ formato: 'pdf', clave: 'corta' });
      expect(sin.status).toBe(400);
      expect(corta.status).toBe(400);
      expect(await portabilidades()).toBe(antes);
    });

    it('con contraseña entrega el PDF cifrado, sin guardar la contraseña', async () => {
      const antes = await portabilidades();
      const res = await comoBinario(portal.post('/portal/descargar').send({ formato: 'pdf', clave }));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(comoTexto(res.body)).toContain('/Encrypt');
      expect(comoTexto(res.body)).not.toContain(clave);
      expect(await portabilidades()).toBe(antes + 1);
      expect(await prisma.solicitudDerecho.findFirst({ where: { pacienteId: titular.id }, orderBy: { id: 'desc' } })).toMatchObject({ estado: 'resuelta' });
      const filas = await prisma.auditLog.findMany({ where: { accion: 'EXPORT_TITULAR', entidadId: titular.id } });
      expect(JSON.stringify(filas)).not.toContain(clave);
    });

    it('Excel y JSON no piden contraseña', async () => {
      expect((await comoBinario(portal.post('/portal/descargar').send({ formato: 'excel' }))).status).toBe(200);
      expect((await portal.post('/portal/descargar').send({ formato: 'json' })).status).toBe(200);
    });
  });

  describe('en admisión, entregado en persona', () => {
    it('sin contraseña no genera el PDF ni resuelve la solicitud', async () => {
      const solicitud = await solicitudNueva();
      await reautenticar();
      const res = await agente.post(`/solicitudes/${solicitud.id}/descargar`).send({ entrega: 'presencial', formato: 'pdf' });
      expect(res.status).toBe(400);
      expect((await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).estado).toBe('verificada');
    });

    it('con la contraseña que elige el titular entrega el PDF cifrado y resuelve la solicitud', async () => {
      const solicitud = await solicitudNueva();
      await reautenticar();
      const res = await comoBinario(agente.post(`/solicitudes/${solicitud.id}/descargar`).send({ entrega: 'presencial', formato: 'pdf', clave }));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(comoTexto(res.body)).toContain('/Encrypt');
      expect(comoTexto(res.body)).not.toContain(clave);
      expect(await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).toMatchObject({ estado: 'resuelta', entrega: 'presencial' });
      const fila = await prisma.auditLog.findFirst({ where: { accion: 'EXPORT_TITULAR', entidadId: titular.id, usuarioId: privacidad.id }, orderBy: { id: 'desc' } });
      expect(fila.detalle).toMatchObject({ entrega: 'presencial', formato: 'pdf', solicitudId: solicitud.id });
      expect(JSON.stringify(fila.detalle)).not.toContain(clave);
    });

    it('si el archivo no se genera (se avisa al contacto para que lo descargue en el portal), no pide contraseña', async () => {
      const solicitud = await solicitudNueva();
      await reautenticar();
      const res = await agente.post(`/solicitudes/${solicitud.id}/descargar`).send({ entrega: 'contacto_registrado', formato: 'pdf' });
      expect(res.status).toBe(200);
      expect(await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).toMatchObject({ estado: 'resuelta', entrega: 'contacto_registrado' });
    });

    it('la pantalla de la solicitud pide la contraseña para el PDF', async () => {
      const solicitud = await solicitudNueva();
      await reautenticar();
      const res = await agente.get(`/solicitudes/${solicitud.id}`).set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/name="clave"/);
      expect(res.text).toMatch(/Contraseña del PDF/i);
    });
  });

  it('la pantalla del portal pide la contraseña junto al botón de PDF', async () => {
    const res = await portal.get('/portal/mis-datos').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/name="clave"/);
    expect(res.text).toMatch(/Descargar en PDF/);
  });
});
