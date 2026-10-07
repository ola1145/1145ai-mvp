import { describe, expect, it } from 'vitest';
import { jobs, read } from './helpers.js';

/** Root config that other lanes depend on (change requests A4-1, T7-1, Q1-2). */

describe('root vitest.config.ts collects every lane that has tests', () => {
  const cfg = read('vitest.config.ts');
  it.each([
    ['services/*/test-integration/**/*.test.ts', 'T7-1: the tool-api stub tests; the DynamoDB Local file skips itself without DYNAMODB_LOCAL_ENDPOINT'],
    ['tests/e2e/isolation/test/**/*.test.ts', 'Q1-2: the isolation self-tests (no network); the real-AWS file skips without ISOLATION_*'],
    ['evals/**/test/**/*.test.ts', 'A4: the eval runner tests'],
    ['infra/cdk/test/**/*.test.ts', 'P4: CDK assertions'],
    ['scripts/**/test/**/*.test.ts', 'P3 and friends'],
  ])('includes %s', (glob, why) => {
    expect(cfg, why).toContain(`'${glob}'`);
  });
  it('leaves the node:test harness (tests/e2e/harness, scenarios) to e2e.yml', () => {
    expect(cfg).not.toMatch(/'tests\/e2e\/(harness|scenarios)/);
  });
});

describe('root tsconfig.json typechecks the new folders', () => {
  const cfg = read('tsconfig.json');
  it.each([
    'evals/**/*.ts', // A4-1
    'services/*/test-integration/**/*.ts', // T7-1
    'services/*/bench/**/*.ts', // T7-1
    'tests/e2e/isolation/**/*.ts', // Q1-2
  ])('includes %s', (glob) => {
    expect(cfg).toContain(`"${glob}"`);
  });
});

describe('Makefile', () => {
  const mk = read('Makefile');
  it('has an evals target that runs the scenario suite, and lists it in .PHONY', () => {
    expect(mk).toMatch(/^\.PHONY:.*\bevals\b/m);
    expect(mk).toMatch(/^evals:\n\tpnpm exec tsx evals\/src\/cli\.ts --runs 5$/m);
  });
  it('has a lint-workflows target for the pinned-action and bot-list checks', () => {
    expect(mk).toMatch(/^\.PHONY:.*\blint-workflows\b/m);
    expect(mk).toMatch(/^lint-workflows:\n\tpnpm exec tsx scripts\/ci\/check-workflows\.ts \.github\/workflows$/m);
  });
});

describe('ci.yml evals job (A4-1)', () => {
  it('exists, runs only when prompts, templates, the style package or evals change, and has a timeout', () => {
    const evals = jobs('ci.yml').evals;
    expect(evals, 'add an evals job to ci.yml').toBeDefined();
    expect(evals).toMatch(/timeout-minutes:\s*[1-8]\b/);
    for (const path of ['evals/', 'packages/conversation-style/', 'system_prompt|prompts', 'prompts\\.py', 'templates/']) expect(evals).toContain(path);
    expect(evals).toContain('pnpm exec tsx evals/src/cli.ts --runs 2');
    expect(evals, 'no third-party paths-filter action: a git diff is enough and keeps the pin list short').not.toMatch(/dorny/);
  });
});
