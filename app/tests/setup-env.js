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
