const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba, rutAleatorio } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const { descifrar } = require('../../src/lib/cifrado');
const consentimiento = require('../../src/services/consentimientoService');
const verificacion = require('../../src/services/verificacionService');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// El rol de privacidad resuelve las solicitudes de derechos (Hito 3). El
// servicio, no solo la vista, impide ejecutar sin la verificación que acepta
// cada derecho; la supresión borra lo que no hay que conservar y bloquea lo
// clínico (Ley 20.584, art. 13).
describe('Gestión de solicitudes de derechos (rol privacidad)', () => {
  const password = 'Password123!';
  let operador;
  let privacidad;
  let agente;
  const pacientes = {};
  const citas = [];

  beforeAll(async () => {
    operador = await usuarioDePrueba('derechos-gestion-operador@medibox.local', 'operador', password);
    privacidad = await usuarioDePrueba('derechos-gestion-privacidad@medibox.local', 'privacidad', password);
    ({ agent: agente } = await loginAgent(app, { email: privacidad.email, password }));
    for (const clave of ['supresion', 'codigo', 'rectificacion', 'pendiente']) {
      pacientes[clave] = await pacienteDePrueba({ nombre: `Gestion ${clave}`, contacto: `+5697400${String(Object.keys(pacientes).length).padStart(4, '0')}`, createdAt: haceHoras(72) });
    }
  });

  afterAll(async () => {
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('ejecutar una solicitud sin verificar responde 409', async () => {
    const solicitud = await solicitudDePrueba(pacientes.pendiente, operador, { derecho: 'bloqueo' });
    const res = await agente.post(`/solicitudes/${solicitud.id}/ejecutar`).send({ respuesta: 'Bloqueado' });
    expect(res.status).toBe(409);
    expect((await prisma.paciente.findUnique({ where: { id: pacientes.pendiente.id } })).bloqueado).toBe(false);
  });

  it('rechazar no sirve para cerrar una solicitud por falta de verificación: sigue pendiente', async () => {
    const solicitud = await solicitudDePrueba(pacientes.pendiente, operador, { derecho: 'acceso' });
    expect((await agente.post(`/solicitudes/${solicitud.id}/rechazar`).send({ respuesta: 'No se pudo verificar' })).status).toBe(409);
    expect((await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } })).estado).toBe('recibida');
  });

  it('una supresión verificada por código no se ejecuta aunque la solicitud figure verificada', async () => {
    const contacto = (await prisma.paciente.findUnique({ where: { id: pacientes.codigo.id } })).contactoCifrado;
    const solicitud = await solicitudDePrueba(pacientes.codigo, operador, { derecho: 'rectificacion', campo: 'nombre', valorPropuesto: 'Otro Nombre' }, { metodo: 'codigo', contacto: descifrar('paciente.contacto', contacto) });
    // Se fuerza el caso que la vista no permite: una supresión con código.
    await prisma.solicitudDerecho.update({ where: { id: solicitud.id }, data: { derecho: 'supresion' } });
    expect((await agente.post(`/solicitudes/${solicitud.id}/ejecutar`).send({ respuesta: 'Suprimido' })).status).toBe(409);
    expect((await prisma.paciente.findUnique({ where: { id: pacientes.codigo.id } })).contactoCifrado).not.toBeNull();
  });

  it('la supresión con cédula borra el contacto y al representante, revoca los consentimientos, bloquea y anula las citas futuras', async () => {
    const paciente = pacientes.supresion;
    const solicitanteOperador = { id: operador.id, permisos: ['paciente.read', 'consentimiento.write'] };
    await verificacion.verificarConCedula(paciente.id, solicitanteOperador);
    const [estado] = await consentimiento.estadoPorPaciente(paciente.id);
    await consentimiento.otorgar({ pacienteId: paciente.id, finalidadClave: estado.finalidad.clave, textoId: estado.textoVigente.id, canal: 'presencial' }, solicitanteOperador);
    const medico = await prisma.medico.findFirstOrThrow();
    const box = await prisma.box.findFirstOrThrow();
    const futura = await prisma.cita.create({ data: { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: new Date('2099-06-01'), horaInicio: '02:00', horaFin: '02:15' } });
    citas.push(futura.id);

    const solicitud = await solicitudDePrueba(paciente, operador, { derecho: 'supresion' }, { metodo: 'cedula' });
    const res = await agente.post(`/solicitudes/${solicitud.id}/ejecutar`).send({ respuesta: 'Se suprimió su contacto; sus datos clínicos se conservan bloqueados por la Ley 20.584.' });
    expect(res.status).toBe(200);

    const fila = await prisma.paciente.findUnique({ where: { id: paciente.id } });
    expect(fila.contactoCifrado).toBeNull();
    expect(fila.bloqueado).toBe(true);
    const consentimientos = await prisma.consentimiento.findMany({ where: { pacienteId: paciente.id } });
    expect(consentimientos.length).toBe(1);
    expect(consentimientos[0].revocadoEl).not.toBeNull();
    expect((await prisma.cita.findUnique({ where: { id: futura.id } })).anulada).toBe(true);

    const resuelta = await prisma.solicitudDerecho.findUnique({ where: { id: solicitud.id } });
    expect(resuelta).toMatchObject({ estado: 'resuelta', resueltaPorId: privacidad.id });
    expect(descifrar('solicitud.respuesta', resuelta.respuestaCifrada)).toMatch(/Ley 20\.584/);
    // Del contacto suprimido no queda copia: el historial registra el cambio sin el valor.
    const historial = await prisma.historialCambio.findFirst({ where: { pacienteId: paciente.id, campo: 'contacto', solicitudId: solicitud.id } });
    expect(historial.valorAnteriorCifrado).toBeNull();
  });

  it('una rectificación no cambia la ficha hasta que privacidad la ejecuta, y deja historial con la solicitud', async () => {
    const paciente = pacientes.rectificacion;
    const solicitud = await solicitudDePrueba(paciente, operador, { derecho: 'rectificacion', campo: 'rut', valorPropuesto: rutAleatorio() }, { metodo: 'cedula' });
    const antes = await prisma.paciente.findUnique({ where: { id: paciente.id } });
    expect(antes.rutIndice).toEqual(paciente.rutIndice);

    expect((await agente.post(`/solicitudes/${solicitud.id}/ejecutar`).send({ respuesta: 'Se corrigió su RUT.' })).status).toBe(200);
    const despues = await prisma.paciente.findUnique({ where: { id: paciente.id } });
    expect(despues.rutIndice).not.toEqual(paciente.rutIndice);
    const historial = await prisma.historialCambio.findFirst({ where: { pacienteId: paciente.id, campo: 'rut' } });
    expect(historial.solicitudId).toBe(solicitud.id);
  });

  it('la lista de privacidad muestra las pendientes con su vencimiento', async () => {
    const res = await agente.get('/solicitudes').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Gestion pendiente');
  });

  it('operador, médico, gestor y admin no entran a /solicitudes; privacidad no entra a /pacientes', async () => {
    for (const rol of ['operador', 'medico', 'gestor', 'admin']) {
      const usuario = await usuarioDePrueba(`derechos-gestion-${rol}@medibox.local`, rol, password);
      const { agent } = await loginAgent(app, { email: usuario.email, password });
      expect((await agent.get('/solicitudes')).status).toBe(403);
    }
    expect((await agente.get('/pacientes')).status).toBe(403);
  });

  it('el rol privacidad tiene exactamente sus cinco permisos', async () => {
    const rol = await prisma.rol.findUniqueOrThrow({ where: { nombre: 'privacidad' }, include: { permisos: { include: { permiso: true } } } });
    expect(rol.permisos.map((p) => p.permiso.clave).sort()).toEqual(['dashboard.read', 'derechos.gestionar', 'derechos.registrar', 'incidentes.gestionar', 'notificaciones.read']);
  });

  it('cada ejecución queda en la auditoría', async () => {
    const filas = await prisma.auditLog.findMany({ where: { usuarioId: privacidad.id, accion: 'EJECUTAR_DERECHO' } });
    expect(filas.length).toBeGreaterThanOrEqual(2);
  });
});
