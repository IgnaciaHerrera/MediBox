const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const { descifrar } = require('../../src/lib/cifrado');
const derechos = require('../../src/services/derechosService');
const consentimiento = require('../../src/services/consentimientoService');
const verificacion = require('../../src/services/verificacionService');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// La oposición no procede contra lo que el hospital hace por ley (la atención,
// los avisos de citas, el registro de accesos): se responde con un rechazo
// fundado, que queda registrado y avisa que se puede reclamar ante la Agencia
// (Ley 21.719, art. 11). Antes ni siquiera se podía registrar: daba un error 400
// y el titular no recibía respuesta alguna.
describe('Oposición a un tratamiento que el hospital hace por ley', () => {
  const password = 'Password123!';
  const pacientes = {};
  let operador;
  let privacidad;
  let agentePrivacidad;
  let agenteOperador;

  const respuestaDe = async (id) => descifrar('solicitud.respuesta', (await prisma.solicitudDerecho.findUniqueOrThrow({ where: { id } })).respuestaCifrada);

  beforeAll(async () => {
    operador = await usuarioDePrueba('oposicion-ley-operador@medibox.local', 'operador', password);
    const usuario = await usuarioDePrueba('oposicion-ley-privacidad@medibox.local', 'privacidad', password);
    privacidad = { id: usuario.id, permisos: ['derechos.registrar', 'derechos.gestionar'] };
    ({ agent: agentePrivacidad } = await loginAgent(app, { email: usuario.email, password }));
    ({ agent: agenteOperador } = await loginAgent(app, { email: operador.email, password }));
    for (const clave of ['atencion', 'avisos', 'propia', 'sinverificar', 'vista']) {
      pacientes[clave] = await pacienteDePrueba({ nombre: `Ley ${clave}`, contacto: `+5697900${String(Object.keys(pacientes).length).padStart(4, '0')}`, createdAt: haceHoras(72) });
    }
  });

  afterAll(async () => {
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('se puede registrar una oposición a la atención, a los avisos o al registro de accesos', async () => {
    for (const finalidadClave of ['atencion', 'avisos', 'trazabilidad']) {
      const { id } = await derechos.registrarSolicitud(
        { pacienteId: pacientes.atencion.id, derecho: 'oposicion', canal: 'presencial', finalidadClave },
        { id: operador.id, permisos: ['paciente.read', 'derechos.registrar'] },
      );
      expect(await prisma.solicitudDerecho.findUnique({ where: { id } })).toMatchObject({ derecho: 'oposicion', finalidadClave, estado: 'recibida' });
    }
  });

  it('un uso que no existe sigue dando error', async () => {
    await expect(
      derechos.registrarSolicitud(
        { pacienteId: pacientes.atencion.id, derecho: 'oposicion', canal: 'presencial', finalidadClave: 'marketing' },
        { id: operador.id, permisos: ['paciente.read', 'derechos.registrar'] },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Indica a qué uso o tratamiento se opone' });
  });

  it('ejecutarla responde 409: no hay nada que revocar, se rechaza con fundamento', async () => {
    const solicitud = await solicitudDePrueba(pacientes.avisos, operador, { derecho: 'oposicion', finalidadClave: 'avisos' }, { metodo: 'cedula' });
    await expect(derechos.ejecutar(solicitud.id, privacidad, { respuesta: 'Listo.' })).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).estado).toBe('verificada');
  });

  it('se rechaza sin escribir nada: el fundamento sale de la ley y lleva el aviso de reclamo', async () => {
    const solicitud = await solicitudDePrueba(pacientes.atencion, operador, { derecho: 'oposicion', finalidadClave: 'atencion' }, { metodo: 'cedula' });
    await derechos.rechazar(solicitud.id, privacidad, {});

    expect(await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).toMatchObject({ estado: 'rechazada', resultado: 'rechazada', resueltaPorId: privacidad.id });
    const respuesta = await respuestaDe(solicitud.id);
    expect(respuesta).toMatch(/no procede/i);
    expect(respuesta).toContain('La atención de salud');
    expect(respuesta).toContain('Ley 20.584');
    expect(respuesta).toContain(derechos.AVISO_RECLAMO);
    expect(await prisma.auditLog.count({ where: { accion: 'RECHAZAR_DERECHO', entidadId: pacientes.atencion.id, usuarioId: privacidad.id } })).toBeGreaterThanOrEqual(1);
    // El titular sigue siendo atendido: nada se bloquea ni se revoca.
    expect((await prisma.paciente.findUnique({ where: { id: pacientes.atencion.id } })).bloqueado).toBe(false);
  });

  it('si privacidad escribe su propia respuesta, se usa esa, también con el aviso de reclamo', async () => {
    const solicitud = await solicitudDePrueba(pacientes.propia, operador, { derecho: 'oposicion', finalidadClave: 'trazabilidad' }, { metodo: 'cedula' });
    await derechos.rechazar(solicitud.id, privacidad, { respuesta: 'El registro de accesos es obligatorio y es su garantía.' });
    const respuesta = await respuestaDe(solicitud.id);
    expect(respuesta).toContain('El registro de accesos es obligatorio y es su garantía.');
    expect(respuesta).toContain(derechos.AVISO_RECLAMO);
  });

  it('sin verificar la identidad queda pendiente: ni se ejecuta ni se rechaza', async () => {
    const solicitud = await solicitudDePrueba(pacientes.sinverificar, operador, { derecho: 'oposicion', finalidadClave: 'atencion' });
    await expect(derechos.rechazar(solicitud.id, privacidad, {})).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).estado).toBe('recibida');
  });

  it('una oposición a un uso con consentimiento sigue revocándolo, como antes', async () => {
    const cedula = { id: operador.id, permisos: ['paciente.read', 'consentimiento.write'] };
    await verificacion.verificarConCedula(pacientes.vista.id, cedula);
    const estado = (await consentimiento.estadoPorPaciente(pacientes.vista.id)).find((e) => e.finalidad.clave === 'encuestas');
    await consentimiento.otorgar({ pacienteId: pacientes.vista.id, finalidadClave: 'encuestas', textoId: estado.textoVigente.id, canal: 'presencial' }, cedula);
    const solicitud = await solicitudDePrueba(pacientes.vista, operador, { derecho: 'oposicion', finalidadClave: 'encuestas' }, { metodo: 'cedula' });
    await derechos.ejecutar(solicitud.id, privacidad, { respuesta: 'No se le enviarán encuestas.' });
    expect(await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).toMatchObject({ estado: 'resuelta', resultado: 'atendida' });
    expect(await prisma.consentimiento.count({ where: { pacienteId: pacientes.vista.id, revocadoEl: null } })).toBe(0);
  });

  describe('lo que ve el personal', () => {
    it('la ficha ofrece estos tratamientos al registrar una oposición', async () => {
      const res = await agenteOperador.get(`/pacientes/${pacientes.vista.id}`).set('Accept', 'text/html');
      expect(res.status).toBe(200);
      for (const clave of ['atencion', 'avisos', 'trazabilidad']) expect(res.text).toContain(`value="${clave}"`);
    });

    it('privacidad ve la solicitud con el rechazo ya redactado y sin el botón de ejecutar', async () => {
      const solicitud = await solicitudDePrueba(pacientes.vista, operador, { derecho: 'oposicion', finalidadClave: 'avisos' }, { metodo: 'cedula' });
      const datos = await derechos.obtenerParaGestion(solicitud.id, privacidad);
      expect(datos.solicitud.porLey).toMatchObject({ nombre: expect.stringContaining('avisos') });
      expect(datos.solicitud.rechazoSugerido).toMatch(/no procede/i);

      const res = await agentePrivacidad.get(`/solicitudes/${solicitud.id}`).set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Rechazar con fundamento');
      expect(res.text).not.toContain('Ejecutar y responder');
    });

    it('rechazar desde la pantalla, con el texto sugerido, cierra la solicitud', async () => {
      const solicitud = await solicitudDePrueba(pacientes.vista, operador, { derecho: 'oposicion', finalidadClave: 'trazabilidad' }, { metodo: 'cedula' });
      const res = await agentePrivacidad.post(`/solicitudes/${solicitud.id}/rechazar`).send({ respuesta: '' });
      expect(res.status).toBe(200);
      expect((await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).estado).toBe('rechazada');
    });
  });
});
