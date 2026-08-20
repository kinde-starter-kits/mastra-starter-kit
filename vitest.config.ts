import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts'],
    // The auth integration tests boot a real Mastra server per file.
    testTimeout: 30_000
  }
});
