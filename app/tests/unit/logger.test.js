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

describe('error serializer', () => {
  const { Prisma } = require('@prisma/client');
  const { serializarError } = require('../../src/lib/logger');
  const argumentos = 'data: { nombre: "Ana Secreta", email: "ana.secreta@hospital.cl", passwordHash: "$2b$12$HASHSECRETO" }';

  it('drops the query arguments that Prisma copies into its error message', () => {
    const err = new Prisma.PrismaClientValidationError(`Invalid \`prisma.usuario.create()\` invocation:\n{ ${argumentos} }`, {
      clientVersion: '5.22.0',
    });

    const log = JSON.stringify(serializarError(err));

    ['Ana Secreta', 'ana.secreta@hospital.cl', 'HASHSECRETO'].forEach((dato) => expect(log).not.toContain(dato));
    expect(serializarError(err).type).toBe('PrismaClientValidationError');
  });

  it('keeps the code and the field names of a known Prisma error, not their values', () => {
    const err = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed\n${argumentos}`, {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { modelName: 'Usuario', target: ['email'] },
    });

    const serializado = serializarError(err);

    expect(serializado).toMatchObject({ code: 'P2002', modelo: 'Usuario', campos: ['email'] });
    expect(JSON.stringify(serializado)).not.toContain('ana.secreta@hospital.cl');
  });

  it('serializes other errors as usual', () => {
    expect(serializarError(new Error('algo inesperado')).message).toBe('algo inesperado');
  });
});
