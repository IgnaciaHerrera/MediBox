const fs = require('fs');
const path = require('path');

// Canal por el que MediBox envía mensajes al contacto registrado del
// paciente: el código de verificación de identidad, el código de ingreso al
// portal y los recordatorios. Se elige con CANAL_ENVIO:
//
//   - 'smtp': el correo del propio hospital (SMTP_HOST, SMTP_PORT, SMTP_USER,
//     SMTP_PASSWORD, SMTP_REMITENTE). Sin proveedores externos de SMS, porque
//     el proyecto es autoalojado: un contacto telefónico no recibe nada y se
//     verifica con la cédula.
//   - 'simulado' (por omisión fuera de producción): los mensajes quedan en
//     memoria (las pruebas los leen) y, fuera de las pruebas, en
//     registro/buzon-simulado.txt, que hace de bandeja de entrada del
//     paciente: no es un log y la aplicación nunca lo sirve por HTTP. El
//     archivo se reescribe con los últimos 50 mensajes de esta ejecución: los
//     códigos vencen a los 10 minutos, así que no se acumulan códigos y
//     contactos en claro.
//
// En producción solo vale 'smtp': sin él, el envío falla y quien llama ofrece
// la verificación con la cédula.

const MAXIMO_EN_MEMORIA = 50;
const ARCHIVO_SIMULADO = process.env.BUZON_SIMULADO_ARCHIVO || path.join(__dirname, '..', '..', 'registro', 'buzon-simulado.txt');
const ES_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const enviados = [];
let transporte = null;

function modo() {
  if (process.env.CANAL_ENVIO === 'smtp') return 'smtp';
  return process.env.NODE_ENV === 'production' ? null : 'simulado';
}

function transporteSmtp() {
  if (!transporte) {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_REMITENTE } = process.env;
    if (!SMTP_HOST || !SMTP_REMITENTE) throw new Error('Falta SMTP_HOST o SMTP_REMITENTE');
    const puerto = Number(SMTP_PORT) || 587;
    // Se carga solo si se usa: en desarrollo y pruebas no hace falta.
    const nodemailer = require('nodemailer');
    transporte = nodemailer.createTransport({
      host: SMTP_HOST,
      port: puerto,
      // 465 es TLS directo; en 587 se exige STARTTLS: el código nunca viaja en claro.
      secure: puerto === 465,
      requireTLS: puerto !== 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
    });
  }
  return transporte;
}

function guardarSimulado(destino, mensaje) {
  enviados.push({ destino, mensaje, enviadoEl: new Date() });
  if (enviados.length > MAXIMO_EN_MEMORIA) enviados.shift();
  if (process.env.NODE_ENV !== 'test') {
    fs.mkdirSync(path.dirname(ARCHIVO_SIMULADO), { recursive: true });
    fs.writeFileSync(ARCHIVO_SIMULADO, enviados.map((m) => `[${m.enviadoEl.toISOString()}] Para ${m.destino}: ${m.mensaje}\n`).join(''));
  }
}

/**
 * Envía un mensaje a un contacto del paciente.
 *
 * @param {string} destino - teléfono o correo, en claro.
 * @param {string} mensaje
 * @returns {Promise<void>}
 * @throws {Error} si no hay un canal para ese destino: en producción sin
 *   SMTP, o un teléfono con SMTP. Quien llama lo trata como "sin canal".
 *
 * Consumidores: verificacionService.enviarCodigo, portalService.solicitarIngreso,
 *   recordatorioService.enviarRecordatorios.
 */
async function enviar(destino, mensaje) {
  const canal = modo();
  if (canal === 'simulado') {
    guardarSimulado(destino, mensaje);
    return;
  }
  if (canal !== 'smtp') throw new Error('No hay un canal de envío configurado');
  if (!ES_CORREO.test(String(destino).trim())) throw new Error('El contacto no es un correo: no hay canal para teléfonos');
  await transporteSmtp().sendMail({ from: process.env.SMTP_REMITENTE, to: String(destino).trim(), subject: 'MediBox', text: mensaje });
}

/**
 * @param {string} destino
 * @returns {({destino: string, mensaje: string, enviadoEl: Date}|undefined)}
 *   el último mensaje simulado para ese destino.
 *
 * Consumidores: tests.
 */
function ultimo(destino) {
  return [...enviados].reverse().find((m) => m.destino === destino);
}

/**
 * Descarta el transporte SMTP creado, para que se vuelva a leer la
 * configuración. Solo para pruebas.
 *
 * Consumidores: tests/unit/canalEnvio.test.js.
 */
function reiniciar() {
  transporte = null;
}

module.exports = { enviar, ultimo, reiniciar };
