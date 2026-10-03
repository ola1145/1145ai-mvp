import { defineConfig } from 'vitest/config';

// Standalone config: tests/e2e is its own npm project, not part of the root pnpm workspace.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
