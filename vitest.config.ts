import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@1145/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) } },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      // Stub-based tests run as-is. Anything that needs DynamoDB Local skips itself unless DYNAMODB_LOCAL_ENDPOINT is set (T7-1).
      'services/*/test-integration/**/*.test.ts',
      'engines/*/test/**/*.test.ts',
      'orchestration/test/**/*.test.ts',
      'scripts/**/test/**/*.test.ts',
      'infra/cdk/test/**/*.test.ts',
      'evals/**/test/**/*.test.ts',
      // Isolation self-tests: no network. The real-AWS file skips unless ISOLATION_* is set (Q1-2).
      // tests/e2e/harness and scenarios use node:test and run in e2e.yml, not here.
      'tests/e2e/isolation/test/**/*.test.ts',
    ],
    environment: 'node',
  },
});
