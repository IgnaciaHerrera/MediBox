const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const { solicitudDePrueba, limpiarPacientes } = require('../helpers/derechos');
const { descifrar } = require('../../src/lib/cifrado');
const derechos = require('../../src/services/derechosService');
const pacienteService = require('../../src/services/pacienteService');
const { comoBinario, textoDelExcel } = require('../helpers/archivo');

const haceHoras = (horas) => new Date(Date.now() - horas * 60 * 60 * 1000);

// Hallazgos de la revisión final de la rama: casos que deshacían una
// supresión o un bloqueo, o que dejaban al titular sin poder ejercer sus
// derechos.
describe('Revisión final: bloqueo y supresión de punta a punta', () => {
  const password = 'Password123!';
  let operador;
  let privacidadUsuario;
  let privacidad;
  let agenteOperador;
  let agentePrivacidad;
  const pacientes = {};

  beforeAll(async () => {
    operador = await usuarioDePrueba('revision-operador@medibox.local', 'operador', password);
    privacidadUsuario = await usuarioDePrueba('revision-privacidad@medibox.local', 'privacidad', password);
    privacidad = { id: privacidadUsuario.id, permisos: ['dashboard.read', 'notificaciones.read', 'derechos.registrar', 'derechos.gestionar'] };
    ({ agent: agenteOperador } = await loginAgent(app, { email: operador.email, password }));
    ({ agent: agentePrivacidad } = await loginAgent(app, { email: privacidadUsuario.email, password }));
    for (const clave of ['editado', 'bloqueoYSupresion', 'contactoAnterior', 'bloqueadoConDerechos']) {
      pacientes[clave] = await pacienteDePrueba({ nombre: `Revision ${clave}`, contacto: '+56979000001', createdAt: haceHoras(72) });
    }
  });

  afterAll(async () => {
    await limpiarPacientes(Object.values(pacientes).map((p) => p.id));
    await prisma.$disconnect();
  });

  it('un paciente bloqueado no se puede editar por id directo, ni por la API ni por la vista', async () => {
    const paciente = pacientes.editado;
    const datos = { nombre: 'Revision Editado', rut: descifrar('paciente.rut', paciente.rutCifrado), fechaNacimiento: '1990-01-01', contacto: '+56979000999' };
    await prisma.paciente.update({ where: { id: paciente.id }, data: { bloqueado: true, contactoCifrado: null } });

    expect((await agenteOperador.patch(`/api/pacientes/${paciente.id}`).send(datos)).status).toBe(404);
    expect((await agenteOperador.post(`/pacientes/${paciente.id}/editar`).send(datos)).status).toBe(404);
    expect((await prisma.paciente.findUnique({ where: { id: paciente.id } })).contactoCifrado).toBeNull();
  });

  it('un bloqueo antiguo no levanta el bloqueo de una supresión posterior', async () => {
    const paciente = pacientes.bloqueoYSupresion;
    const bloqueo = await solicitudDePrueba(paciente, operador, { derecho: 'bloqueo' }, { metodo: 'cedula' });
    await derechos.ejecutar(bloqueo.id, privacidad, { respuesta: 'Bloqueado.' });
    const supresion = await prisma.solicitudDerecho.create({
      data: { pacienteId: paciente.id, derecho: 'supresion', canal: 'presencial', venceEl: new Date(), recibidaPorId: operador.id },
    });
    // La supresión llega con el paciente ya bloqueado: el operador ya no lo
    // ve, así que la verifica con cédula otra persona de privacidad (cuatro
    // ojos: quien verifica no ejecuta).
    const segunda = await usuarioDePrueba('revision-privacidad-2@medibox.local', 'privacidad', password);
    const { agent: agenteSegunda } = await loginAgent(app, { email: segunda.email, password });
    await agenteSegunda.post(`/verificacion/${paciente.id}/cedula`).send({ cedulaVista: 'si' });
    await derechos.verificarSolicitud(supresion.id, { ...privacidad, id: segunda.id });
    await expect(derechos.ejecutar(supresion.id, { ...privacidad, id: segunda.id }, { respuesta: 'Suprimido.' })).rejects.toMatchObject({ statusCode: 409 });
    await derechos.ejecutar(supresion.id, privacidad, { respuesta: 'Suprimido.' });

    expect((await agentePrivacidad.post(`/solicitudes/${bloqueo.id}/desbloquear`)).status).toBe(409);
    expect((await prisma.paciente.findUnique({ where: { id: paciente.id } })).bloqueado).toBe(true);
  });

  it('la supresión borra también los contactos anteriores del historial y de las rectificaciones', async () => {
    const paciente = pacientes.contactoAnterior;
    const actual = await pacienteService.datosParaTitular(paciente.id);
    await pacienteService.actualizarPaciente(paciente.id, { ...actual, contacto: '+56979000002' }, operador.id);
    const rectificacion = await solicitudDePrueba(paciente, operador, { derecho: 'rectificacion', campo: 'contacto', valorPropuesto: '+56979000003' });
    expect(await prisma.historialCambio.count({ where: { pacienteId: paciente.id, campo: 'contacto', valorAnteriorCifrado: { not: null } } })).toBe(1);

    const supresion = await solicitudDePrueba(paciente, operador, { derecho: 'supresion' }, { metodo: 'cedula' });
    await derechos.ejecutar(supresion.id, privacidad, { respuesta: 'Suprimido.' });

    expect(await prisma.historialCambio.count({ where: { pacienteId: paciente.id, campo: 'contacto', valorAnteriorCifrado: { not: null } } })).toBe(0);
    expect((await prisma.solicitudDerecho.findUnique({ where: { id: rectificacion.id } })).valorPropuestoCifrado).toBeNull();
  });

  it('un titular bloqueado puede seguir ejerciendo sus derechos a través de privacidad', async () => {
    const paciente = pacientes.bloqueadoConDerechos;
    const bloqueo = await solicitudDePrueba(paciente, operador, { derecho: 'bloqueo' }, { metodo: 'cedula' });
    await derechos.ejecutar(bloqueo.id, privacidad, { respuesta: 'Bloqueado.' });

    // El operador ya no lo ve; privacidad registra la nueva solicitud desde la anterior.
    expect((await agenteOperador.post(`/pacientes/${paciente.id}/solicitudes`).send({ derecho: 'acceso', canal: 'presencial' })).status).toBe(404);
    const nueva = await agentePrivacidad.post(`/solicitudes/${bloqueo.id}/nueva`).send({ derecho: 'acceso', canal: 'presencial' });
    expect(nueva.status).toBe(200);
    expect((await agentePrivacidad.post(`/verificacion/${paciente.id}/cedula`).send({ cedulaVista: 'si' })).status).toBe(200);
    expect((await agentePrivacidad.post(`/solicitudes/${nueva.body.id}/verificar`)).status).toBe(200);
    await agentePrivacidad.post('/solicitudes/reautenticar').send({ password });
    const archivo = await comoBinario(agentePrivacidad.post(`/solicitudes/${nueva.body.id}/descargar`).send({ entrega: 'presencial', formato: 'excel' }));
    expect(archivo.status).toBe(200);
    expect(textoDelExcel(archivo.body)).toContain('Revision bloqueadoConDerechos');
  });

  it('la reautenticación tiene un límite de intentos', async () => {
    let res;
    for (let i = 0; i < 7; i += 1) {
      res = await agentePrivacidad.post('/solicitudes/reautenticar').send({ password: 'Incorrecta123' });
      if (res.status === 429) break;
    }
    expect(res.status).toBe(429);
  });
});
