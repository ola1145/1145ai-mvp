import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../push.sh');
const DOC = resolve(import.meta.dirname, '../../../docs/API_KEYS.md');

function run(env: string, args: string[] = ['acme/1145ai-mvp', 'dev', '--dry-run']) {
  const dir = mkdtempSync(join(tmpdir(), 'push-'));
  writeFileSync(join(dir, '.env'), env);
  // PATH is stripped of gh and aws on purpose: a dry run must never reach for them.
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir } });
  return { ...r, dir };
}

const docNames = (section: string) => {
  const body = readFileSync(DOC, 'utf8').split(/^## /m).find((s) => s.startsWith(section)) ?? '';
  return body.split('\n').filter((l) => l.startsWith('|')).flatMap((l) => (l.split('|')[1] ?? '').match(/`[A-Z][A-Z0-9_]+`/g) ?? []).map((n) => n.replaceAll('`', ''));
};

describe('scripts/secrets/push.sh --dry-run', () => {
  it('takes its names from docs/API_KEYS.md and never prints a value', () => {
    const runtime = docNames('Product runtime');
    expect(runtime).toContain('DEEPGRAM_API_KEY');
    const env = runtime.map((n, i) => `${n}=sekret-value-${i}`).join('\n') + '\nCLAUDE_CODE_OAUTH_TOKEN="quoted-token"\n';
    const r = run(env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('aws: 1145/dev/runtime');
    for (const n of runtime) expect(r.stdout).toContain(n);
    expect(r.stdout).toContain('github: CLAUDE_CODE_OAUTH_TOKEN');
    expect(r.stdout + r.stderr).not.toMatch(/sekret-value|quoted-token/);
  });

  it('sends only what workflows read to GitHub, and keeps runtime-only keys out of it', () => {
    const r = run('TELNYX_API_KEY=a\nDEEPGRAM_API_KEY=b\nGITHUB_MCP_PAT=c\nGH_ADMIN_TOKEN=d\nSTRIPE_MCP_TEST_KEY=e\nAUTOMERGE_PAT=f\n');
    const gh = r.stdout.split('\n').filter((l) => l.startsWith('github: ')).map((l) => l.slice(8));
    expect(gh).toContain('TELNYX_API_KEY'); // e2e.yml reads it
    expect(gh).toContain('AUTOMERGE_PAT');
    expect(gh).not.toContain('DEEPGRAM_API_KEY');
    for (const local of ['GITHUB_MCP_PAT', 'GH_ADMIN_TOKEN', 'STRIPE_MCP_TEST_KEY']) expect(gh).not.toContain(local);
    expect(r.stdout).toMatch(/aws: 1145\/dev\/runtime.*2 keys/);
  });

  it('reads .env as data, never as shell', () => {
    const r = run('TELNYX_API_KEY=$(touch pwned)\nDEEPGRAM_API_KEY=`touch pwned2`\n');
    expect(r.status).toBe(0);
    expect(existsSync(join(r.dir, 'pwned'))).toBe(false);
    expect(existsSync(join(r.dir, 'pwned2'))).toBe(false);
  });

  it('refuses a missing .env, a bad repo and a bad stage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-'));
    expect(spawnSync('bash', [SCRIPT, 'acme/x', 'dev', '--dry-run'], { cwd: dir, encoding: 'utf8' }).status).not.toBe(0);
    expect(run('A=1\n', ['not-a-repo', 'dev', '--dry-run']).status).not.toBe(0);
    expect(run('A=1\n', ['acme/x', '../prod', '--dry-run']).status).not.toBe(0);
  });

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });
});
