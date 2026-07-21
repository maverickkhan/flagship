/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  setupFiles: ['<rootDir>/test/jest-env.js'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    // Bootstrap/infra glue with no branching logic worth gating on; the
    // coverage gate protects domain code (DECISIONS.md).
    '!src/main.ts',
    '!src/app.setup.ts',
    '!src/realtime/**',
    '!src/**/*.module.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      branches: 70,
    },
  },
  // Integration tests share one database; parallel workers would interleave
  // truncates. Unit tests are pure and still run fast in-band.
  maxWorkers: 1,
};
