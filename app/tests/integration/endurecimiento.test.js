const os = require('os');
const crypto = require('crypto');
const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const canalEnvio = require('../../src/lib/canalEnvio');
const verificacion = require('../../src/services/verificacionService');
const derechos = require('../../src/services/derechosService');
const usuarioService = require('../../src/services/usuarioService');
const { estimarAlcance } = require('../../src/services/incidenteService');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// Pendientes técnicos del Hito 3 que quedaron como riesgos residuales: cada
// caso es el que el informe declaraba abierto.
describe('Endurecimiento de los pendientes del Hito 3', () => {
  const password = 'Password123!';
  let operador;
  let privacidad;
  let admin;
  const pacientes = {};
  const solicitante = () => ({ id: operador.id, permisos: ['paciente.read', 'derechos.registrar'] });
  const gestor = () => ({ id: privacidad.id, permisos: ['derechos.registrar', 'derechos.gestionar'] });

  beforeAll(async () => {
    operador = await usuarioDePrueba('endurecimiento-operador@medibox.local', 'operador', password);
    privacidad = await usuarioDePrueba('endurecimiento-privacidad@medibox.local', 'privacidad', password);
    admin = await usuarioDePrueba('endurecimiento-admin@medibox.local', 'admin', password);
    for (const [i, clave] of ['intentos', 'doble', 'cerrada', 'supresion'].entries()) {
      pacientes[clave] = await pacienteDePrueba({ nombre: `Endurecimiento ${clave}`, contacto: `+5697810000${i}`, createdAt: haceHoras(72) });
    }
  });

  afterAll(async () => {
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('intentos simultáneos con códigos incorrectos no superan el tope de 5', async () => {
    const paciente = pacientes.intentos;
    await verificacion.enviarCodigo(paciente.id, solicitante());
    const codigo = canalEnvio.ultimo('+56978100000').mensaje.match(/\b(\d{6})\b/)[1];
    const incorrecto = codigo === '000000' ? '111111' : '000000';

    const resultados = await Promise.allSettled(Array.from({ length: 12 }, () => verificacion.confirmarCodigo(paciente.id, incorrecto, solicitante())));
    expect(resultados.every((r) => r.status === 'rejected')).toBe(true);
    const fila = await prisma.verificacionIdentidad.findFirst({ where: { pacienteId: paciente.id }, orderBy: { id: 'desc' } });
    expect(fila.intentos).toBe(5);
    // Agotados los intentos, ni el correcto sirve.
    await expect(verificacion.confirmarCodigo(paciente.id, codigo, solicitante())).rejects.toMatchObject({ statusCode: 400 });
  });

  it('una rectificación ejecutada dos veces a la vez se aplica una sola vez', async () => {
    const paciente = pacientes.doble;
    const solicitud = await solicitudDePrueba(paciente, operador, { derecho: 'rectificacion', campo: 'nombre', valorPropuesto: 'Endurecimiento Corregido' }, { metodo: 'cedula' });

    const resultados = await Promise.allSettled([
      derechos.ejecutar(solicitud.id, gestor(), { respuesta: 'Corregido.' }),
      derechos.ejecutar(solicitud.id, gestor(), { respuesta: 'Corregido.' }),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(resultados.find((r) => r.status === 'rejected').reason.statusCode).toBe(409);
    expect(await prisma.historialCambio.count({ where: { pacienteId: paciente.id, campo: 'nombre' } })).toBe(1);
  });

  it('una solicitud cerrada ya no abre la ficha completa del titular', async () => {
    const paciente = pacientes.cerrada;
    const solicitud = await solicitudDePrueba(paciente, operador, { derecho: 'oposicion', finalidadClave: 'encuestas' }, { metodo: 'cedula' });

    const abierta = await derechos.obtenerParaGestion(solicitud.id, gestor());
    expect(abierta.paciente.rut).toBeDefined();
    await derechos.ejecutar(solicitud.id, gestor(), { respuesta: 'No se le enviarán encuestas.' });

    const cerrada = await derechos.obtenerParaGestion(solicitud.id, gestor());
    expect(cerrada.paciente.nombre).toBe('Endurecimiento cerrada');
    expect(cerrada.paciente.rut).toBeUndefined();
    expect(cerrada.paciente.fechaNacimiento).toBeUndefined();
    expect(cerrada.paciente.contacto).toBeNull();
    expect(cerrada.historial).toEqual([]);
  });

  it('si no se puede anotar la supresión, igual se anulan sus citas y queda en la auditoría', async () => {
    const paciente = pacientes.supresion;
    const especialidad = await prisma.especialidad.upsert({ where: { nombre: 'Especialidad Endurecimiento' }, update: {}, create: { nombre: 'Especialidad Endurecimiento' } });
    const medico = await prisma.medico.create({ data: { nombre: 'Dr. Endurecimiento', especialidadId: especialidad.id } });
    const pasillo = await prisma.pasillo.upsert({ where: { nombre: 'Pasillo Endurecimiento' }, update: {}, create: { nombre: 'Pasillo Endurecimiento' } });
    const box = await prisma.box.create({ data: { nombre: 'Box Endurecimiento', pasilloId: pasillo.id } });
    const manana = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const cita = await prisma.cita.create({ data: { pacienteId: paciente.id, medicoId: medico.id, boxId: box.id, fecha: manana, horaInicio: '09:00', horaFin: '09:30' } });

    const solicitud = await solicitudDePrueba(paciente, operador, { derecho: 'supresion' }, { metodo: 'cedula' });
    const archivoAnterior = process.env.SUPRESIONES_ARCHIVO;
    // Un directorio en lugar de un archivo: la escritura falla.
    process.env.SUPRESIONES_ARCHIVO = os.tmpdir();
    try {
      await derechos.ejecutar(solicitud.id, gestor(), { respuesta: 'Suprimido.' });
    } finally {
      if (archivoAnterior === undefined) delete process.env.SUPRESIONES_ARCHIVO;
      else process.env.SUPRESIONES_ARCHIVO = archivoAnterior;
    }

    expect((await prisma.cita.findUnique({ where: { id: cita.id } })).anulada).toBe(true);
    const fila = await prisma.auditLog.findFirst({ where: { accion: 'ANOTAR_SUPRESION', entidadId: paciente.id } });
    expect(fila).toMatchObject({ resultado: 'fallido', actor: 'sistema' });

    await prisma.notificacion.deleteMany({ where: { mensaje: { contains: 'Endurecimiento' } } });
    await prisma.cita.deleteMany({ where: { boxId: box.id } });
    await prisma.box.delete({ where: { id: box.id } });
    await prisma.medico.delete({ where: { id: medico.id } });
  });

  it('cambiar la contraseña de una cuenta cierra sus otras sesiones, pero no la de quien la cambia', async () => {
    const { agent: sesionOperador } = await loginAgent(app, { email: operador.email, password });
    const { agent: sesionAdmin } = await loginAgent(app, { email: admin.email, password });
    expect((await sesionOperador.get('/api/pacientes')).status).toBe(200);

    await usuarioService.cambiarPassword(operador.id, password, admin.id);
    expect((await sesionOperador.get('/api/pacientes')).status).toBe(401);
    expect((await sesionAdmin.get('/api/usuarios')).status).toBe(200);

    // Al cambiar la propia, se conserva la sesión desde la que se cambia.
    const { agent: propia } = await loginAgent(app, { email: admin.email, password });
    const cambio = await propia.post(`/usuarios/${admin.id}/editar`).type('form').send({ nombre: admin.nombre, rolId: admin.rolId, nuevaPassword: password });
    expect(cambio.status).toBe(302);
    expect((await propia.get('/api/usuarios')).status).toBe(200);
    expect((await sesionAdmin.get('/api/usuarios')).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { accion: 'CERRAR_SESIONES', entidadId: operador.id } })).toBeGreaterThan(0);
  });

  it('el alcance de un incidente cuenta como menor a quien lo era a la fecha del incidente', async () => {
    const titular = await pacienteDePrueba({ nombre: 'Endurecimiento Era Menor', fechaNacimiento: '2000-06-01' });
    // Un día al azar entre 2002 y 2015 (la auditoría no se borra entre
    // ejecuciones): el titular tenía entre 1 y 15 años, y hoy es adulto.
    const desde = new Date(Date.UTC(2002, 0, 1) + crypto.randomInt(4700) * 24 * 60 * 60 * 1000);
    const hasta = new Date(desde.getTime() + 24 * 60 * 60 * 1000 - 1);
    await prisma.auditLog.create({ data: { usuarioId: operador.id, accion: 'READ', entidad: 'Paciente', entidadId: titular.id, timestamp: new Date(desde.getTime() + 12 * 60 * 60 * 1000) } });
    const alcance = await estimarAlcance({ desde, hasta, usuarioId: operador.id });
    expect(alcance.titulares).toBe(1);
    expect(alcance.menores).toBe(1);
    await limpiarPacientes([titular.id]);
  });
});

// Unidad del adaptador SMTP: la frontera es el servidor de correo del
// hospital, así que se reemplaza solo el transporte de nodemailer.
describe('Canal de envío por SMTP', () => {
  const entorno = { ...process.env };
  afterEach(() => {
    process.env = { ...entorno };
    canalEnvio.reiniciar();
    jest.resetModules();
  });

  it('envía solo a un correo, por TLS, y nunca a un teléfono', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    jest.resetModules();
    jest.doMock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail })) }));
    const canal = require('../../src/lib/canalEnvio');
    Object.assign(process.env, { CANAL_ENVIO: 'smtp', SMTP_HOST: 'correo.hospital.local', SMTP_PORT: '587', SMTP_REMITENTE: 'medibox@hospital.local' });
    canal.reiniciar();

    await canal.enviar('titular@correo.cl', 'Su código es 123456');
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'titular@correo.cl', from: 'medibox@hospital.local' }));
    expect(require('nodemailer').createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, requireTLS: true, secure: false }));
    await expect(canal.enviar('+56911112222', 'x')).rejects.toThrow(/teléfonos/);
  });

  it('en producción sin SMTP no envía nada', async () => {
    Object.assign(process.env, { NODE_ENV: 'production' });
    delete process.env.CANAL_ENVIO;
    await expect(canalEnvio.enviar('titular@correo.cl', 'x')).rejects.toThrow(/canal/);
  });
});
