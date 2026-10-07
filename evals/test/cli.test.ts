import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

const STUB = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-stub.ts');
const OFFLINE = {}; // an empty environment: what CI and `make evals` get

describe('eval CLI', () => {
  it('exits 0 on the shipped scenarios with the offline fakes', async () => {
    const lines: string[] = [];
    const { code } = await runCli([], { env: OFFLINE, log: (l) => lines.push(l) });
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(code).toBe(0);
    expect(lines.at(-1)).toMatch(/scenarios passed.*judge average.*onboarding median/);
  });

  it('exits 1 and names the failing scenario when an agent sounds robotic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-'));
    writeFileSync(join(dir, 'robotic.yaml'), [
      'agent: customer', 'channel: webchat', 'turns:', '  - caller: "hi"',
      '    fake: { reply: "I apologize for any inconvenience. Your call is important to us.", tools: [] }',
    ].join('\n'));
    const lines: string[] = [];
    const { code } = await runCli([], { dir, env: OFFLINE, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/FAIL robotic .*\[style\]/);
  });

  it('rejects unknown scenario ids and bad flags', async () => {
    expect((await runCli(['--only', 'nope'], { env: OFFLINE, log: () => {} })).code).toBe(2);
    expect((await runCli(['--runs', '0'], { env: OFFLINE, log: () => {} })).code).toBe(2);
  });
});

describe('live runs are opt-in', () => {
  const only = ['--only', 'customer-booking-happy'];

  it('stays offline by default, even when a live module is configured', async () => {
    const lines: string[] = [];
    const { code, suite } = await runCli(only, { env: { EVALS_LIVE_MODULE: STUB }, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(suite!.results[0]!.judge?.notes).toBe('heuristic');
    expect(lines.join('\n')).toMatch(/offline/);
    expect(lines.join('\n')).toMatch(/EVALS_LIVE_MODULE is ignored/);
  });

  it('uses the live module only with EVALS_LIVE=1', async () => {
    const lines: string[] = [];
    const { code, suite } = await runCli(only, { env: { EVALS_LIVE: '1', EVALS_LIVE_MODULE: STUB }, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(suite!.results[0]!.judge?.notes).toBe('stub-live');
    expect(lines[0]).toMatch(/live/);
  });

  it('refuses to fall back to the fakes when live was asked for but cannot be set up', async () => {
    expect((await runCli(only, { env: { EVALS_LIVE: '1' }, log: () => {} })).code).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'evals-live-'));
    const empty = join(dir, 'empty.mjs');
    writeFileSync(empty, 'export const nothing = 1;\n');
    const lines: string[] = [];
    expect((await runCli(only, { env: { EVALS_LIVE: '1', EVALS_LIVE_MODULE: empty }, log: (l) => lines.push(l) })).code).toBe(2);
    expect(lines.join('\n')).toMatch(/createLive/);
  });
});
