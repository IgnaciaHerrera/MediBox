module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['src/services/**/*.js'],
  coverageThreshold: {
    './src/services/**/*.js': { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
