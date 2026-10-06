import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** The root vitest config only includes services/<svc>/test. Run these with:
 *    pnpm vitest run --config services/tool-api/test-integration/vitest.config.ts
 *  DynamoDB Local tests skip cleanly unless DYNAMODB_LOCAL_ENDPOINT is set (see bench/README.md). */
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  resolve: { alias: { '@1145/shared': fileURLToPath(new URL('../../../packages/shared/src/index.ts', import.meta.url)) } },
  test: { include: ['services/tool-api/test-integration/**/*.test.ts'], environment: 'node', testTimeout: 20_000 },
});
