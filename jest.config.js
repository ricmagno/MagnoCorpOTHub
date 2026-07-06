module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  transform: {
    // isolatedModules: transpile each file independently instead of building a full
    // incremental ts.Program. Needed as a workaround for a ts-jest/typescript version
    // mismatch (installed typescript is newer than ts-jest's LanguageService integration
    // expects) that otherwise crashes every test suite with
    // "Cannot read properties of undefined (reading 'sourceFile')" inside
    // typescript.js's document registry. Type errors are still caught by `tsc --noEmit`
    // and the editor; this only affects how Jest transpiles test files.
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/server.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testTimeout: 10000
};