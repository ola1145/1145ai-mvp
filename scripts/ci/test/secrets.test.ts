import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { entropy, parseAddedLines, scanAddedLines, type AddedFile } from '../secrets.js';
import { jobs, root } from './helpers.js';

/**
 * SEC-03: trufflehog --only-verified cannot see a secret nobody can verify (an HMAC key, a webhook secret, a service
 * token we generated ourselves). This pass reads only the lines a PR adds and looks for provider key shapes and for
 * high-entropy literals assigned to secret-looking names. Test fixtures are allowlisted by path or by an inline marker.
 */

const file = (path: string, ...text: string[]): AddedFile => ({ path, added: text.map((t, i) => ({ line: i + 1, text: t })) });
const scan = (path: string, text: string) => scanAddedLines([file(path, text)]);
const rules = (path: string, text: string) => scan(path, text).map((f) => f.rule);

// Built at runtime so this file is not itself a secret-looking diff.
const fake = {
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  ghp: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  stripeLive: 'sk_' + 'live_' + '51Hxxk2eZvKYlo2C0a9B8c7D6e5F4g3H',
  slack: 'xoxb' + '-123456789012-123456789012-abcdefghijklmnopqrstuvwx',
  telegram: '7123456789:' + 'AAH3k2jL9sdf8sd7f6s5d4f3g2h1j0kLmNo',
  pem: '-----BEGIN RSA ' + 'PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  random: '9f3k2ldkA8s7dfh2Jk3LmQ0pZ1xC4vB6nM5',
  hex: '4f9a1c7e2b8d3065a1f4c9e7b2d8036ab5c1e9f7d3a2b4c6',
};

describe('provider key shapes', () => {
  it.each([
    ['AWS access key id', `const id = "${fake.aws}";`, 'aws-access-key'],
    ['GitHub token', `GH=${fake.ghp}`, 'github-token'],
    ['live Stripe key', `key: '${fake.stripeLive}'`, 'stripe-key'],
    ['Slack token', `SLACK = "${fake.slack}"`, 'slack-token'],
    ['Telegram bot token', `TELEGRAM_BOT_TOKEN="${fake.telegram}"`, 'telegram-bot-token'],
    ['JWT', `const t = "${fake.jwt}"`, 'jwt'],
    ['private key block', fake.pem, 'private-key'],
  ])('flags a %s in source', (_n, text, rule) => {
    expect(rules('services/tool-api/src/lib/x.ts', text)).toContain(rule);
  });
});

describe('literals assigned to secret-looking names', () => {
  it.each([
    `const ENGINE_SECRET = "${fake.random}";`,
    `TOOL_API_TOKEN_SECRET_CURRENT: '${fake.hex}'`,
    `"stepUpSecret": "${fake.random}"`,
    `password = "${fake.random}"`,
    `VAPID_PRIVATE_KEY=${fake.hex}`,
  ])('flags %s', (text) => {
    expect(rules('services/x/src/a.ts', text)).toContain('secret-literal');
  });

  it('does not flag a reference, an env lookup, a placeholder or a short or plain-word value', () => {
    for (const text of [
      'const ENGINE_SECRET = process.env.ENGINE_SECRET;',
      'ENGINE_SECRET: ${{ secrets.ENGINE_SECRET }}',
      'secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:tool-api/token-AbCdEf"',
      'password = "changeme-changeme-changeme"',
      'apiKey = "<your-api-key-goes-here-1234>"',
      'token = "abc123"',
      'const secretName = "tool-api/token-secret-current-previous"',
      'TOKEN_TTL_SECONDS = "3600"',
    ]) expect(rules('services/x/src/a.ts', text), text).toEqual([]);
  });
});

describe('allowlist', () => {
  it('lets test fixtures and docs carry fake-looking values', () => {
    for (const path of ['services/tool-api/test/auth.test.ts', 'engines/livekit-agent/tests/test_x.py', 'tests/e2e/harness/fakes/x.ts', 'docs/API_KEYS.md', '.env.example', 'contracts/openapi/examples/a.json']) {
      expect(rules(path, `const ENGINE_SECRET = "${fake.random}";`), path).toEqual([]);
      expect(rules(path, `GH=${fake.ghp}`), path).toEqual([]);
    }
  });
  it('never lets a private key or an AWS key through on a path alone', () => {
    expect(rules('services/x/test/a.test.ts', fake.pem)).toContain('private-key');
    expect(rules('docs/a.md', `${fake.aws}`)).toContain('aws-access-key');
  });
  it('allows the AWS documentation example key', () => {
    expect(rules('services/x/src/a.ts', 'AKIAIOSFODNN7EXAMPLE')).toEqual([]);
  });
  it('honours an inline marker with a reason on the same line', () => {
    expect(rules('services/x/src/a.ts', `const ENGINE_SECRET = "${fake.random}"; // allowlist-secret: dev fixture`)).toEqual([]);
  });
  it('skips lockfiles and generated files', () => {
    expect(rules('pnpm-lock.yaml', `integrity: sha512-${fake.random}${fake.random}`)).toEqual([]);
  });
});

describe('what a finding says', () => {
  it('names the file and line, the rule, never the value, and what to do', () => {
    const [f] = scanAddedLines([file('services/x/src/a.ts', 'ok', `const ENGINE_SECRET = "${fake.random}";`)]);
    expect(f).toMatchObject({ path: 'services/x/src/a.ts', line: 2, rule: 'secret-literal' });
    expect(f!.message).not.toContain(fake.random);
    expect(f!.message).toMatch(/Secrets Manager|env/);
    expect(f!.message).not.toContain('\n');
  });
});

describe('entropy', () => {
  it('is high for random strings and low for words', () => {
    expect(entropy(fake.random)).toBeGreaterThan(4);
    expect(entropy('aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(0);
    expect(entropy('changemechangemechangeme')).toBeLessThan(3);
  });
});

describe('reading a diff', () => {
  it('collects only added lines, with their line numbers in the new file', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts', 'index 1..2 100644', '--- a/a.ts', '+++ b/a.ts',
      '@@ -3,0 +4,2 @@ function x() {', '+const a = 1;', '+const b = 2;',
      '@@ -10 +12 @@', '-old', '+new',
      'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    ].join('\n');
    expect(parseAddedLines(diff)).toEqual([{ path: 'a.ts', added: [{ line: 4, text: 'const a = 1;' }, { line: 5, text: 'const b = 2;' }, { line: 12, text: 'new' }] }]);
  });
});

describe('check-secrets.ts end to end', () => {
  const tsx = join(root, 'node_modules/.bin/tsx');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
  function pr(path: string, body: string) {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'head');
    return spawnSync(tsx, [join(root, 'scripts/ci/check-secrets.ts')], { cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, HEAD_SHA: git(dir, 'rev-parse', 'HEAD') } });
  }
  it('fails a PR that adds a secret literal, and the output has no secret in it', () => {
    const r = pr('services/x/src/a.ts', `export const ENGINE_SECRET = "${fake.random}";\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('services/x/src/a.ts:1');
    expect(r.stdout).not.toContain(fake.random);
  });
  it('passes a PR whose only secret-looking text is in a test fixture', () => {
    expect(pr('services/x/test/a.test.ts', `export const ENGINE_SECRET = "${fake.random}";\n`).status).toBe(0);
  });
});

describe('ci.yml secrets-scan', () => {
  const job = jobs('ci.yml')['secrets-scan']!;
  it('pins trufflehog to a release commit, not @main', () => {
    expect(job).not.toMatch(/trufflehog@main/);
    expect(job).toMatch(/trufflesecurity\/trufflehog@[0-9a-f]{40}/);
  });
  it('keeps the verified pass and adds the unverified pass from the base checkout', () => {
    expect(job).toContain('--only-verified');
    expect(job, 'run the base copy of the scanner with the PR checkout as the working directory').toContain('../node_modules/.bin/tsx ../scripts/ci/check-secrets.ts');
    expect(job).toContain('working-directory: pr');
    expect(job).toMatch(/ref:\s*"?\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}"?/);
  });
  it('lints every workflow in the PR with the base copy of the linter', () => {
    expect(job).toContain('../node_modules/.bin/tsx ../scripts/ci/check-workflows.ts .github/workflows');
  });
});
