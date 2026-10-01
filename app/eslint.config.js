const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');

const nodeGlobals = {
  process: 'readonly',
  module: 'writable',
  require: 'readonly',
  __dirname: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
};

const jestGlobals = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  afterAll: 'readonly',
  afterEach: 'readonly',
  jest: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  history: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly',
  URLSearchParams: 'readonly',
  Event: 'readonly',
  FileReader: 'readonly',
  DOMParser: 'readonly',
};

module.exports = [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
      'no-console': 'warn',
    },
  },
  {
    files: ['tests/**'],
    languageOptions: {
      globals: { ...nodeGlobals, ...jestGlobals },
    },
  },
  {
    files: ['src/public/js/**'],
    languageOptions: {
      sourceType: 'script',
      globals: browserGlobals,
    },
  },
];
