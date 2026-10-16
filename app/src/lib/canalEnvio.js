const fs = require('fs');
const path = require('path');

// Canal por el que MediBox envía mensajes al contacto registrado del
// paciente (hoy, solo el código de verificación de identidad).
//
// ponytail: en desarrollo y pruebas el envío se simula. Los mensajes quedan en
// memoria (las pruebas los leen) y, fuera de las pruebas, en
// registro/buzon-simulado.txt, que hace de bandeja de entrada del paciente: no
// es un log y la aplicación nunca lo sirve por HTTP. En producción no hay
// canal configurado y el envío falla, así que se verifica con la cédula. El
// upgrade es un adaptador SMTP con el correo del propio hospital, sin
// proveedores externos de SMS (el proyecto es autoalojado); con él, un
// contacto telefónico seguiría sin poder recibir el código.

const MAXIMO_EN_MEMORIA = 50;
const ARCHIVO_SIMULADO = process.env.BUZON_SIMULADO_ARCHIVO || path.join(__dirname, '..', '..', 'registro', 'buzon-simulado.txt');

const enviados = [];

/**
 * Envía un mensaje a un contacto del paciente.
 *
 * @param {string} destino - teléfono o correo, en claro.
 * @param {string} mensaje
 * @returns {void}
 * @throws {Error} en producción, porque no hay un canal real configurado.
 *
 * Consumidores: services/verificacionService.enviarCodigo.
 */
function enviar(destino, mensaje) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('No hay un canal de envío configurado');
  }
  enviados.push({ destino, mensaje, enviadoEl: new Date() });
  if (enviados.length > MAXIMO_EN_MEMORIA) enviados.shift();
  if (process.env.NODE_ENV !== 'test') {
    fs.mkdirSync(path.dirname(ARCHIVO_SIMULADO), { recursive: true });
    fs.appendFileSync(ARCHIVO_SIMULADO, `[${new Date().toISOString()}] Para ${destino}: ${mensaje}\n`);
  }
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

module.exports = { enviar, ultimo };
