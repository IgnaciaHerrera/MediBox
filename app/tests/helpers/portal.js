const request = require('supertest');
const canalEnvio = require('../../src/lib/canalEnvio');
const { descifrar } = require('../../src/lib/cifrado');

/**
 * RUT en claro de un paciente de prueba (para ingresar al portal con él).
 *
 * @param {object} paciente - fila de pacientes.
 * @returns {string}
 */
function rutDe(paciente) {
  return descifrar('paciente.rut', paciente.rutCifrado);
}

/**
 * Un navegador anónimo del portal: pone `agent.token` (el token CSRF de la
 * sesión) en cada POST. Al ingresar la sesión se regenera con un token
 * nuevo, que quien llama debe guardar en `agent.token`.
 *
 * @param {object} app
 * @returns {Promise<object>} agente de supertest.
 */
async function agentePortal(app) {
  const agent = request.agent(app);
  agent.token = (await agent.get('/health')).headers['x-csrf-token'];
  const post = agent.post.bind(agent);
  agent.post = (...args) => post(...args).set('X-CSRF-Token', agent.token);
  return agent;
}

/**
 * Ingresa al portal con el RUT del paciente y el código que llegó a su
 * contacto (canal simulado).
 *
 * @param {object} app
 * @param {object} paciente - fila de pacientes, con contacto registrado.
 * @param {string} contacto - el contacto en claro, para leer el código.
 * @returns {Promise<object>} agente con la sesión del portal abierta.
 */
async function ingresarAlPortal(app, paciente, contacto) {
  const agent = await agentePortal(app);
  await agent.post('/portal/ingresar').send({ rut: rutDe(paciente) });
  const codigo = canalEnvio.ultimo(contacto).mensaje.match(/\b(\d{6})\b/)[1];
  const res = await agent.post('/portal/confirmar').send({ codigo });
  if (res.status !== 200) throw new Error(`No se pudo ingresar al portal: ${res.status} ${JSON.stringify(res.body)}`);
  agent.token = res.headers['x-csrf-token'];
  return agent;
}

module.exports = { rutDe, agentePortal, ingresarAlPortal };
