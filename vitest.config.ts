import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@1145/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'engines/*/test/**/*.test.ts', 'orchestration/test/**/*.test.ts', 'scripts/**/test/**/*.test.ts', 'infra/cdk/test/**/*.test.ts', 'evals/**/test/**/*.test.ts'],
    environment: 'node',
  },
});
