/**
 * Purpose: Loads the project's real environment config for tests, since
 * app.js (what every test imports) never calls dotenv.config() itself —
 * only server.js does, and tests never go through server.js.
 * Parameters: none.
 * Returns: nothing — side effect only (populates process.env).
 * Consumers: jest.config.js's setupFiles, runs once before each test file.
 *
 * Loads the repo-root .env (matching docker-compose.yml's `env_file: .env`,
 * the config actually used in real operation) rather than app/.env, which
 * only holds a host-local DATABASE_URL override for running Prisma's CLI
 * outside Docker and is missing SESSION_SECRET and friends.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

// Las supresiones y las evidencias de un incidente se anotan fuera de la
// base: en las pruebas, en archivos temporales, para no tocar el registro
// real del proyecto.
process.env.EVIDENCIAS_DIR = process.env.EVIDENCIAS_DIR || require('path').join(require('os').tmpdir(), `medibox-evidencias-test-${process.pid}`);
process.env.SUPRESIONES_ARCHIVO =
  process.env.SUPRESIONES_ARCHIVO || require('path').join(require('os').tmpdir(), `medibox-supresiones-test-${process.pid}.jsonl`);
