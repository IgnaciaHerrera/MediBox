const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { pacienteDePrueba, usuarioDePrueba } = require('../helpers/datos');
const { limpiarPacientes } = require('../helpers/derechos');
const { ingresarAlPortal, agentePortal } = require('../helpers/portal');
const { loginAgent } = require('../helpers/csrf');
const { comoBinario, textoDelExcel } = require('../helpers/archivo');
const consentimientoService = require('../../src/services/consentimientoService');
const derechos = require('../../src/services/derechosService');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);
const haceAnios = (anios) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - anios);
  return d.toISOString().slice(0, 10);
};

// Lo que el titular hace en el portal: ve y descarga sus datos (acceso y
// portabilidad), otorga y revoca consentimientos con un clic, y pide una
// rectificación, una supresión o un bloqueo. Siempre sobre sí mismo: el
// paciente sale de la sesión, nunca de la petición.
describe('Portal del titular: sus datos y sus derechos', () => {
  const password = 'Password123!';
  const pacientes = {};
  let privacidad;
  let titular;

  beforeAll(async () => {
    pacientes.titular = await pacienteDePrueba({ nombre: 'Portal Titular', fechaNacimiento: '1980-02-02', contacto: '+56977200001', createdAt: haceHoras(72) });
    pacientes.otro = await pacienteDePrueba({ nombre: 'Portal Otro Paciente', contacto: '+56977200002', createdAt: haceHoras(72) });
    pacientes.nino = await pacienteDePrueba({ nombre: 'Portal Nino', fechaNacimiento: haceAnios(8), contacto: 'apoderado@correo.cl', createdAt: haceHoras(72) });
    pacientes.salida = await pacienteDePrueba({ nombre: 'Portal Salida', contacto: '+56977200004', createdAt: haceHoras(72) });
    privacidad = await usuarioDePrueba('portal-privacidad@medibox.local', 'privacidad', password);
    titular = await ingresarAlPortal(app, pacientes.titular, '+56977200001');
  });

  afterAll(async () => {
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('muestra solo sus datos, y quién accedió a ellos por función', async () => {
    const res = await titular.get('/portal/mis-datos');
    expect(res.status).toBe(200);
    expect(res.body.titular).toMatchObject({ nombre: 'Portal Titular', fechaNacimiento: '1980-02-02', contacto: '+56977200001' });
    expect(JSON.stringify(res.body)).not.toContain('Portal Otro Paciente');
    expect(res.body.accesos.some((a) => a.rol === 'Usted, en el portal')).toBe(true);
    // Para qué se usan sus datos y a quién se comunican (derecho de acceso).
    expect(res.body.tratamiento.destinatarios).toBeDefined();

    const pagina = await titular.get('/portal/mis-datos').set('Accept', 'text/html');
    expect(pagina.status).toBe(200);
    for (const seccion of ['Para qué usamos sus datos', 'Descargar en Excel', 'Descargar en PDF', 'Sus derechos', 'Sus solicitudes y sus respuestas', 'Quién accedió a sus datos']) {
      expect(pagina.text).toContain(seccion);
    }
    expect(pagina.text).not.toContain('Portal Otro Paciente');
    // Sin datos internos.
    expect(res.body.titular.id).toBeUndefined();
    const lectura = await prisma.auditLog.findFirst({ where: { accion: 'READ', entidadId: pacientes.titular.id, actor: 'titular' } });
    expect(lectura).toMatchObject({ usuarioId: null, detalle: { motivo: 'portal' } });
  });

  it('descarga sus datos en Excel o PDF: queda como una portabilidad resuelta en el portal', async () => {
    expect((await titular.post('/portal/descargar').send({ formato: 'json' })).status).toBe(400);
    expect(await prisma.solicitudDerecho.count({ where: { pacienteId: pacientes.titular.id, derecho: 'portabilidad' } })).toBe(0);

    const excel = await comoBinario(titular.post('/portal/descargar').send({ formato: 'excel' }));
    expect(excel.status).toBe(200);
    expect(excel.headers['cache-control']).toBe('no-store');
    expect(excel.headers['content-disposition']).toMatch(/attachment; filename="mis-datos-medibox\.xlsx"/);
    const texto = textoDelExcel(excel.body);
    expect(texto).toContain('Portal Titular');
    expect(texto).toContain('Cómo tratamos mis datos');
    expect(texto).not.toContain('Portal Otro Paciente');

    const pdf = await comoBinario(titular.post('/portal/descargar').send({ formato: 'pdf' }));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');

    const solicitud = await prisma.solicitudDerecho.findFirst({ where: { pacienteId: pacientes.titular.id, derecho: 'portabilidad' } });
    expect(solicitud).toMatchObject({ canal: 'portal', estado: 'resuelta', entrega: 'portal', metodoVerificacion: 'codigo_portal', recibidaPorId: null });
    const exportacion = await prisma.auditLog.findFirst({ where: { accion: 'EXPORT_TITULAR', entidadId: pacientes.titular.id } });
    expect(exportacion).toMatchObject({ actor: 'titular', usuarioId: null, detalle: { formato: 'excel' } });
  });

  it('otorga solo con la casilla marcada y sobre el texto vigente, y revoca con un clic', async () => {
    const [encuestas] = (await consentimientoService.estadoPorPaciente(pacientes.titular.id)).filter((e) => e.finalidad.clave === 'encuestas');
    const textoId = encuestas.textoVigente.id;

    expect((await titular.post('/portal/consentimientos/encuestas/otorgar').send({ textoId })).status).toBe(400);
    expect((await titular.post('/portal/consentimientos/encuestas/otorgar').send({ textoId: textoId + 999, acepto: 'si' })).status).toBe(400);
    expect((await titular.post('/portal/consentimientos/encuestas/otorgar').send({ textoId, acepto: 'si' })).status).toBe(200);
    expect(await consentimientoService.tieneVigente(pacientes.titular.id, 'encuestas')).toBe(true);
    const fila = await prisma.consentimiento.findFirst({ where: { pacienteId: pacientes.titular.id }, orderBy: { id: 'desc' } });
    expect(fila).toMatchObject({ canal: 'portal', registradoPorId: null, otorgadoPor: 'titular' });

    const revocar = await titular.post('/portal/consentimientos/encuestas/revocar');
    expect(revocar.body.revocados).toBe(1);
    expect(await consentimientoService.tieneVigente(pacientes.titular.id, 'encuestas')).toBe(false);
    // Revocar otra vez no dice "revocado".
    expect((await titular.post('/portal/consentimientos/encuestas/revocar')).body.revocados).toBe(0);

    // El personal ve en la ficha que lo registró el propio titular.
    const [estado] = (await consentimientoService.estadoPorPaciente(pacientes.titular.id)).filter((e) => e.finalidad.clave === 'encuestas');
    expect(estado.registradoPor).toBe('el titular, en el portal');
  });

  it('nunca actúa sobre otro paciente, aunque la petición traiga su id', async () => {
    const [recordatorios] = (await consentimientoService.estadoPorPaciente(pacientes.otro.id)).filter((e) => e.finalidad.clave === 'recordatorios');
    const res = await titular
      .post('/portal/consentimientos/recordatorios/otorgar')
      .send({ textoId: recordatorios.textoVigente.id, acepto: 'si', pacienteId: pacientes.otro.id });
    expect(res.status).toBe(200);
    expect(await consentimientoService.tieneVigente(pacientes.otro.id, 'recordatorios')).toBe(false);
    expect(await consentimientoService.tieneVigente(pacientes.titular.id, 'recordatorios')).toBe(true);
  });

  it('una rectificación llega verificada con su código y la aplica privacidad', async () => {
    const res = await titular.post('/portal/solicitudes').send({ derecho: 'rectificacion', campo: 'nombre', valorPropuesto: 'Portal Titular Corregido' });
    expect(res.status).toBe(200);
    expect(res.body.pendienteDeCedula).toBe(false);
    const solicitud = await prisma.solicitudDerecho.findUnique({ where: { id: res.body.id } });
    expect(solicitud).toMatchObject({ estado: 'verificada', canal: 'portal', metodoVerificacion: 'codigo_portal', recibidaPorId: null, verificadaPorId: null });

    const gestor = { id: privacidad.id, permisos: ['derechos.registrar', 'derechos.gestionar'] };
    await derechos.ejecutar(solicitud.id, gestor, { respuesta: 'Corregido.' });
    const despues = (await titular.get('/portal/mis-datos')).body;
    expect(despues.titular.nombre).toBe('Portal Titular Corregido');
    // Ve la respuesta del hospital y el valor que tenía antes.
    expect(despues.solicitudes.find((s) => s.derecho === 'rectificacion')).toMatchObject({ estado: 'resuelta', respuesta: 'Corregido.' });
    expect(despues.historialCambios).toEqual([expect.objectContaining({ campo: 'nombre', valorAnterior: 'Portal Titular' })]);
  });

  it('la supresión y el bloqueo quedan pendientes de la cédula en admisión', async () => {
    const res = await titular.post('/portal/solicitudes').send({ derecho: 'supresion' });
    expect(res.status).toBe(200);
    expect(res.body.pendienteDeCedula).toBe(true);
    const solicitud = await prisma.solicitudDerecho.findUnique({ where: { id: res.body.id } });
    expect(solicitud).toMatchObject({ estado: 'recibida', identidadVerificada: false });

    const gestor = { id: privacidad.id, permisos: ['derechos.registrar', 'derechos.gestionar'] };
    await expect(derechos.ejecutar(solicitud.id, gestor, { respuesta: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    // El acceso y la oposición no son solicitudes del portal: son la descarga y revocar.
    expect((await titular.post('/portal/solicitudes').send({ derecho: 'acceso' })).status).toBe(400);
    // Privacidad la ve en su lista, con el canal portal.
    const pendientes = await derechos.listarPendientes(gestor);
    expect(pendientes.find((p) => p.id === solicitud.id)).toMatchObject({ canal: 'portal', pendienteDeVerificacion: true });
  });

  it('para un menor de 14, el consentimiento lo da su representante', async () => {
    const apoderado = await ingresarAlPortal(app, pacientes.nino, 'apoderado@correo.cl');
    const [encuestas] = (await consentimientoService.estadoPorPaciente(pacientes.nino.id)).filter((e) => e.finalidad.clave === 'encuestas');
    const textoId = encuestas.textoVigente.id;
    expect((await apoderado.get('/portal/mis-datos')).body.requiereRepresentante).toBe(true);
    expect((await apoderado.post('/portal/consentimientos/encuestas/otorgar').send({ textoId, acepto: 'si' })).status).toBe(400);
    const ok = await apoderado
      .post('/portal/consentimientos/encuestas/otorgar')
      .send({ textoId, acepto: 'si', representanteNombre: 'Apoderada Prueba', representanteRut: '11.111.111-1', representanteRelacion: 'madre' });
    expect(ok.status).toBe(200);
    const fila = await prisma.consentimiento.findFirst({ where: { pacienteId: pacientes.nino.id }, orderBy: { id: 'desc' } });
    expect(fila.otorgadoPor).toBe('representante');
  });

  it('salir cierra la sesión, y una sesión del personal no abre el portal', async () => {
    const agente = await ingresarAlPortal(app, pacientes.salida, '+56977200004');
    expect((await agente.get('/portal/mis-datos')).status).toBe(200);
    expect((await agente.post('/portal/salir')).status).toBe(200);
    expect((await agente.get('/portal/mis-datos')).status).toBe(401);

    const { agent: funcionario } = await loginAgent(app, { email: privacidad.email, password });
    expect((await funcionario.get('/portal/mis-datos')).status).toBe(401);
  });

  it('un error en un formulario del portal vuelve a su página, no al panel del personal', async () => {
    const agente = await agentePortal(app);
    const res = await agente.post('/portal/ingresar').set('Accept', 'text/html').type('form').send({ rut: 'no es un rut' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/portal');
  });

  it('si el paciente se bloquea, su sesión del portal se corta', async () => {
    const agente = await ingresarAlPortal(app, pacientes.otro, '+56977200002');
    expect((await agente.get('/portal/mis-datos')).status).toBe(200);
    await prisma.paciente.update({ where: { id: pacientes.otro.id }, data: { bloqueado: true } });
    expect((await agente.get('/portal/mis-datos')).status).toBe(401);
  });
});
