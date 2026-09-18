const express = require('express');
const request = require('supertest');
const { AppError } = require('../../src/lib/AppError');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.get('/boom-known', () => {
    throw new AppError('No encontrado', 404);
  });
  app.get('/boom-unknown', () => {
    throw new Error('algo inesperado');
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps AppError to its statusCode and message', async () => {
    const res = await request(buildApp()).get('/boom-known');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No encontrado' });
  });

  it('maps unknown errors to 500 with a generic message', async () => {
    const res = await request(buildApp()).get('/boom-unknown');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Error interno del servidor' });
  });
});
