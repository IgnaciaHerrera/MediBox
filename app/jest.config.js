module.exports = {
  testEnvironment: 'node',
  // app.js (lo que importan los tests) nunca llama a dotenv.config() —
  // eso vive en server.js, el entry point real, que los tests no cargan.
  // Sin esto, cualquier test que importe app.js corre sin las env vars
  // de .env (ej. SESSION_SECRET), y falla en runtime, no en el assert.
  // Ver tests/setup-env.js: usa el .env de la raíz (el que lee Docker),
  // no app/.env (que solo trae un DATABASE_URL para el CLI de Prisma).
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['src/services/**/*.js'],
  coverageThreshold: {
    './src/services/**/*.js': { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
