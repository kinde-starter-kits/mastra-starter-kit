import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Frontend config is validated at import time, so the UI tests need these.
    env: {
      VITE_KINDE_DOMAIN: 'https://test.kinde.com',
      VITE_KINDE_CLIENT_ID: 'test-client-id',
      VITE_MASTRA_URL: 'http://localhost:4111',
      // The suite runs offline: plan from the bundled fixtures rather than
      // calling a live map server. Discovery itself is tested separately with
      // the network stubbed at the fetch boundary.
      ACTIVITY_SOURCE: 'seeded'
    },
    // The auth integration tests boot a real Mastra server per file.
    testTimeout: 30_000
  }
});
