import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

describe('eval CLI', () => {
  it('exits 0 on the shipped scenarios with the offline fakes', async () => {
    const lines: string[] = [];
    const { code } = await runCli([], { log: (l) => lines.push(l) });
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(code).toBe(0);
    expect(lines.at(-1)).toMatch(/scenarios passed/);
  });

  it('exits 1 and names the failing scenario when an agent sounds robotic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-'));
    writeFileSync(join(dir, 'robotic.yaml'), [
      'agent: customer', 'channel: webchat', 'turns:', '  - caller: "hi"',
      '    fake: { reply: "I apologize for any inconvenience. Your call is important to us.", tools: [] }',
    ].join('\n'));
    const lines: string[] = [];
    const { code } = await runCli([], { dir, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/FAIL robotic .*\[style\]/);
  });

  it('rejects unknown scenario ids and bad flags', async () => {
    expect((await runCli(['--only', 'nope'], { log: () => {} })).code).toBe(2);
    expect((await runCli(['--runs', '0'], { log: () => {} })).code).toBe(2);
  });
});
