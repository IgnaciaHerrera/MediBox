const { Writable } = require('stream');
const express = require('express');
const request = require('supertest');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { serializadoresHttp } = require('../../src/lib/logger');

describe('access log serializers', () => {
  it('logs the path without query string and no cookies or CSRF token', async () => {
    const lineas = [];
    const destino = new Writable({
      write(chunk, _encoding, callback) {
        lineas.push(chunk.toString());
        callback();
      },
    });

    const app = express();
    app.use(pinoHttp({ logger: pino(destino), serializers: serializadoresHttp }));
    app.get('/api/pacientes', (req, res) => {
      res.set('X-CSRF-Token', 'token-de-prueba');
      res.cookie('connect.sid', 'sesion-de-prueba');
      res.json({ ok: true });
    });

    await request(app).get('/api/pacientes').query({ q: '12.345.678-5' }).set('Cookie', 'connect.sid=sesion-anterior');

    const log = lineas.join('');
    expect(JSON.parse(lineas[0]).req.ruta).toBe('/api/pacientes');
    expect(JSON.parse(lineas[0]).res.statusCode).toBe(200);
    ['12.345.678-5', '12345678', 'token-de-prueba', 'sesion-de-prueba', 'sesion-anterior'].forEach((dato) => {
      expect(log).not.toContain(dato);
    });
  });
});
