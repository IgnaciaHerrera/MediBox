const app = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const { loginAgent } = require('../helpers/csrf');
const { usuarioDePrueba, pacienteDePrueba } = require('../helpers/datos');
const canalEnvio = require('../../src/lib/canalEnvio');
const verificacion = require('../../src/services/verificacionService');

const { CEDULA, CODIGO } = verificacion.METODOS;
const HORA = 60 * 60 * 1000;
const haceHoras = (horas) => new Date(Date.now() - horas * HORA);

// Verificación de identidad del titular (Hito 3): la cédula en admisión es
// la base; el código a distancia, un complemento que solo va al contacto que
// el paciente ya tenía registrado y que nunca sale del canal de envío.
describe('Verificación de identidad', () => {
  const password = 'Password123!';
  const contactoA = '+56970000001';
  let rol;
  let funcionario;
  let otroFuncionario;
  let sinPermisos;
  const pacientes = {};

  const solicitante = (u) => ({ id: u.id, permisos: ['paciente.read', 'consentimiento.write'] });

  function codigoEnviado(destino) {
    const mensaje = canalEnvio.ultimo(destino);
    return mensaje && mensaje.mensaje.match(/\b(\d{6})\b/)[1];
  }

  beforeAll(async () => {
    // El permiso consentimiento.write lo crea la Tarea 7; aquí basta un rol
    // propio que lo tenga junto con la lectura de pacientes.
    const claves = ['paciente.read', 'consentimiento.write'];
    await Promise.all(claves.map((clave) => prisma.permiso.upsert({ where: { clave }, update: {}, create: { clave } })));
    rol = await prisma.rol.upsert({ where: { nombre: 'verificacion-test' }, update: {}, create: { nombre: 'verificacion-test' } });
    const permisos = await prisma.permiso.findMany({ where: { clave: { in: claves } } });
    await prisma.rolPermiso.createMany({ data: permisos.map((p) => ({ rolId: rol.id, permisoId: p.id })), skipDuplicates: true });

    funcionario = await usuarioDePrueba('verificacion-funcionario@medibox.local', 'verificacion-test', password);
    otroFuncionario = await usuarioDePrueba('verificacion-otro@medibox.local', 'verificacion-test', password);
    sinPermisos = await usuarioDePrueba('verificacion-consulta@medibox.local', 'consulta', password);

    pacientes.a = await pacienteDePrueba({ nombre: 'Verif A', contacto: contactoA, createdAt: haceHoras(72) });
    pacientes.b = await pacienteDePrueba({ nombre: 'Verif B', contacto: '+56970000002', createdAt: haceHoras(72) });
    pacientes.sinContacto = await pacienteDePrueba({ nombre: 'Verif Sin Contacto', createdAt: haceHoras(72) });
    pacientes.contactoNuevo = await pacienteDePrueba({ nombre: 'Verif Nuevo', contacto: '+56970000003', createdAt: haceHoras(72) });
    pacientes.contactoTardio = await pacienteDePrueba({ nombre: 'Verif Tardio', contacto: '+56970000004', createdAt: haceHoras(72) });
    await prisma.historialCambio.create({ data: { pacienteId: pacientes.contactoNuevo.id, campo: 'contacto', cambiadoPorId: funcionario.id, cambiadoEl: haceHoras(1) } });
    await prisma.historialCambio.create({ data: { pacienteId: pacientes.contactoTardio.id, campo: 'contacto', cambiadoPorId: funcionario.id, cambiadoEl: haceHoras(30) } });
  });

  afterAll(async () => {
    const ids = Object.values(pacientes).map((p) => p.id);
    await prisma.verificacionIdentidad.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.historialCambio.deleteMany({ where: { pacienteId: { in: ids } } });
    await prisma.paciente.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('verificar con cédula deja la verificación vigente con su método y quién verificó', async () => {
    const { verificacionId } = await verificacion.verificarConCedula(pacientes.a.id, solicitante(funcionario));
    const vigente = await verificacion.verificacionVigente(pacientes.a.id, funcionario.id, [CEDULA]);
    expect(vigente).toMatchObject({ id: verificacionId, metodo: CEDULA });
    const fila = await prisma.verificacionIdentidad.findUnique({ where: { id: verificacionId } });
    expect(fila.verificadaPorId).toBe(funcionario.id);
  });

  it('enviar el código lo deja solo en el canal: ni en la respuesta, ni en la auditoría, ni en el log', async () => {
    const { agent } = await loginAgent(app, { email: funcionario.email, password });
    const inicio = new Date();
    const salida = [];
    const escribir = process.stdout.write;
    process.stdout.write = (trozo, ...resto) => {
      salida.push(String(trozo));
      return escribir.call(process.stdout, trozo, ...resto);
    };
    let res;
    try {
      res = await agent.post(`/verificacion/${pacientes.a.id}/enviar-codigo`);
    } finally {
      process.stdout.write = escribir;
    }
    expect(res.status).toBe(200);
    expect(res.body.contactoEnmascarado).toBe('+56 9 •••• 0001');

    const codigo = codigoEnviado(contactoA);
    expect(codigo).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toContain(codigo);
    expect(salida.join('')).not.toContain(codigo);
    const auditoria = await prisma.auditLog.findMany({ where: { timestamp: { gte: inicio } } });
    expect(JSON.stringify(auditoria)).not.toContain(codigo);
    expect(auditoria.map((f) => f.accion)).toContain('VERIFICACION_ENVIADA');

    const fila = await prisma.verificacionIdentidad.findFirst({ where: { pacienteId: pacientes.a.id, metodo: CODIGO }, orderBy: { id: 'desc' } });
    expect(Buffer.from(fila.codigoHash).toString('latin1')).not.toContain(codigo);
  });

  it('sin contacto registrado responde 409 y no deja una verificación a medias', async () => {
    await expect(verificacion.enviarCodigo(pacientes.sinContacto.id, solicitante(funcionario))).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.verificacionIdentidad.count({ where: { pacienteId: pacientes.sinContacto.id } })).toBe(0);
  });

  it('no envía el código a un contacto editado hace una hora', async () => {
    await expect(verificacion.enviarCodigo(pacientes.contactoNuevo.id, solicitante(funcionario))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('no envía el código a un contacto cambiado después de recibir la solicitud', async () => {
    const recibida = haceHoras(48);
    await expect(verificacion.enviarCodigo(pacientes.contactoTardio.id, solicitante(funcionario), { desde: recibida })).rejects.toMatchObject({ statusCode: 409 });
    // Sin solicitud de por medio el contacto ya lleva más de 24 horas estable.
    await expect(verificacion.enviarCodigo(pacientes.contactoTardio.id, solicitante(funcionario))).resolves.toBeDefined();
  });

  it('con el código correcto la verificación queda vigente por código', async () => {
    await verificacion.enviarCodigo(pacientes.b.id, solicitante(funcionario));
    await verificacion.confirmarCodigo(pacientes.b.id, codigoEnviado('+56970000002'), solicitante(funcionario));
    expect(await verificacion.verificacionVigente(pacientes.b.id, funcionario.id, [CEDULA, CODIGO])).toMatchObject({ metodo: CODIGO });
  });

  it('rechaza un código vencido, uno ya usado y uno correcto tras 5 intentos fallidos', async () => {
    const s = solicitante(otroFuncionario);
    const destino = '+56970000002';

    await verificacion.enviarCodigo(pacientes.b.id, s);
    const vencido = codigoEnviado(destino);
    await prisma.verificacionIdentidad.updateMany({ where: { pacienteId: pacientes.b.id, verificadaPorId: otroFuncionario.id, verificadaEl: null }, data: { expiraEl: haceHoras(1) } });
    await expect(verificacion.confirmarCodigo(pacientes.b.id, vencido, s)).rejects.toMatchObject({ statusCode: 400 });

    await verificacion.enviarCodigo(pacientes.b.id, s);
    const usado = codigoEnviado(destino);
    await verificacion.confirmarCodigo(pacientes.b.id, usado, s);
    await expect(verificacion.confirmarCodigo(pacientes.b.id, usado, s)).rejects.toMatchObject({ statusCode: 400 });

    await verificacion.enviarCodigo(pacientes.b.id, s);
    const correcto = codigoEnviado(destino);
    const incorrecto = correcto === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await expect(verificacion.confirmarCodigo(pacientes.b.id, incorrecto, s)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(verificacion.confirmarCodigo(pacientes.b.id, correcto, s)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('la verificación del paciente A no sirve para el B, ni la de un funcionario para otro', async () => {
    const paciente = await pacienteDePrueba({ nombre: 'Verif Aislado', createdAt: haceHoras(72) });
    pacientes.aislado = paciente;
    await verificacion.verificarConCedula(pacientes.a.id, solicitante(funcionario));
    expect(await verificacion.verificacionVigente(paciente.id, funcionario.id, [CEDULA, CODIGO])).toBeNull();
    expect(await verificacion.verificacionVigente(pacientes.a.id, sinPermisos.id, [CEDULA, CODIGO])).toBeNull();
  });

  it('pasados 15 minutos la verificación ya no está vigente', async () => {
    const { verificacionId } = await verificacion.verificarConCedula(pacientes.sinContacto.id, solicitante(funcionario));
    await prisma.verificacionIdentidad.update({ where: { id: verificacionId }, data: { verificadaEl: new Date(Date.now() - 16 * 60 * 1000) } });
    expect(await verificacion.verificacionVigente(pacientes.sinContacto.id, funcionario.id, [CEDULA])).toBeNull();
  });

  it('exigirVerificacion solo con cédula rechaza una verificación por código', async () => {
    await expect(verificacion.exigirVerificacion(pacientes.b.id, funcionario.id, [CEDULA])).rejects.toMatchObject({ statusCode: 403 });
    await expect(verificacion.exigirVerificacion(pacientes.b.id, funcionario.id, [CEDULA, CODIGO])).resolves.toMatchObject({ metodo: CODIGO });
  });

  it('un usuario sin los permisos recibe 403', async () => {
    const { agent } = await loginAgent(app, { email: sinPermisos.email, password });
    expect((await agent.post(`/verificacion/${pacientes.a.id}/cedula`).send({ cedulaVista: 'si' })).status).toBe(403);
  });

  it('la ruta de cédula exige la declaración de haberla visto', async () => {
    const { agent } = await loginAgent(app, { email: funcionario.email, password });
    expect((await agent.post(`/verificacion/${pacientes.a.id}/cedula`).send({})).status).toBe(400);
    expect((await agent.post(`/verificacion/${pacientes.a.id}/cedula`).send({ cedulaVista: 'si' })).status).toBe(200);
  });
});
