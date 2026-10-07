import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The root vitest config only includes services/<svc>/test. Run these with:
 *    pnpm vitest run --config services/tool-api/test-integration/vitest.config.ts
 *  DynamoDB Local tests skip cleanly unless DYNAMODB_LOCAL_ENDPOINT is set (see bench/README.md).
 *  The ApiStack wiring test lives in infra/cdk/test/api-stack.test.ts. */
export default defineConfig({
  root: at('../../..'),
  resolve: {
    alias: {
      '@1145/shared': at('../../../packages/shared/src/index.ts'),
      'aws-cdk-lib': at('../../../infra/cdk/node_modules/aws-cdk-lib'),
      constructs: at('../../../infra/cdk/node_modules/constructs'),
    },
  },
  test: { include: ['services/tool-api/test-integration/**/*.test.ts'], environment: 'node', testTimeout: 20_000 },
});
