/**
 * The unverified secret pass (threat model SEC-03). trufflehog --only-verified cannot see a secret nobody can verify
 * against a provider: HMAC keys, webhook secrets and the service tokens we generate ourselves. This looks only at the
 * lines a PR adds, for (1) provider key shapes and (2) high-entropy literals assigned to secret-looking names.
 *
 * Allowlist: test fixtures and docs by path, one line by the marker `allowlist-secret: <reason>`. A private key block,
 * a live Stripe key and a real-looking AWS key id are never allowed by path alone.
 */
export interface AddedLine { line: number; text: string }
export interface AddedFile { path: string; added: AddedLine[] }
export interface SecretFinding { path: string; line: number; rule: string; message: string }

export const MARKER = 'allowlist-secret';

/** Paths where fake credentials are normal. Each entry says why, so the list stays honest. */
export const ALLOWED_PATHS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /(^|\/)(test|tests|__tests__|fixtures|fakes|testdata)\//, why: 'test fixtures' },
  { re: /\.(test|spec)\.[cm]?[jt]sx?$/, why: 'test files' },
  { re: /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/, why: 'python tests' },
  { re: /^docs\/|\.md$/, why: 'documentation' },
  { re: /(^|\/)\.env\.(example|sample)$/, why: 'example env file' },
  { re: /(^|\/)examples?\//, why: 'contract examples' },
  { re: /(^|\/)(pnpm-lock\.yaml|uv\.lock|package-lock\.json|yarn\.lock)$/, why: 'lockfiles hold integrity hashes' },
];

interface ShapeRule { id: string; re: RegExp; /** Not allowlistable by path. */ strict?: boolean; skip?: (match: string) => boolean; hint: string }

const SHAPES: ShapeRule[] = [
  { id: 'private-key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, strict: true, hint: 'a private key was added; keep it in Secrets Manager and read it at runtime' },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, strict: true, skip: (m) => m.includes('EXAMPLE'), hint: 'an AWS access key id was added; use the OIDC role or an IAM role instead' },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, strict: true, hint: 'a live Stripe key was added; read it from Secrets Manager' },
  { id: 'stripe-webhook-secret', re: /\bwhsec_[A-Za-z0-9]{24,}\b/, hint: 'a Stripe webhook secret was added; read it from Secrets Manager' },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/, hint: 'a GitHub token was added; use an Actions secret' },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/, hint: 'a Slack token was added; use an Actions secret' },
  { id: 'telegram-bot-token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, hint: 'a Telegram bot token was added; read it from Secrets Manager' },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, hint: 'an Anthropic key was added; use an Actions secret' },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/, hint: 'an API key (sk-...) was added; read it from Secrets Manager' },
  { id: 'elevenlabs-key', re: /\bsk_[a-f0-9]{40,}\b/, hint: 'an ElevenLabs key was added; read it from Secrets Manager' },
  { id: 'telnyx-key', re: /\bKEY[0-9A-Z]{20,}_[A-Za-z0-9]{20,}\b/, hint: 'a Telnyx API key was added; read it from Secrets Manager' },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, hint: 'a Google API key was added; read it from Secrets Manager' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, hint: 'a signed token was added; mint tokens at runtime, never commit them' },
];

/** `NAME = "value"`, `NAME: 'value'`, `"name": "value"` and dotenv `NAME=value`, where NAME contains a secret-ish word. */
const ASSIGNMENT = /([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|signing[_-]?key|hmac|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_.~-]{20,})["']?/i;
const PLACEHOLDER = /example|placeholder|changeme|change-me|your[-_]|x{4,}|dummy|fake|test|sample|redacted|todo|lorem|\*{3,}/i;
const REFERENCE = /process\.env|os\.environ|getenv|secrets\.|\benv\.|^arn:|^\$|^%|^\{\{/;
const WORDS_ONLY = /^[a-z]+(?:[-_./:][a-z]+)+$/i;
const HEX_ONLY = /^[0-9a-f]+$/i;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

function looksRandom(value: string): boolean {
  if (REFERENCE.test(value) || PLACEHOLDER.test(value) || WORDS_ONLY.test(value)) return false;
  if (HEX_ONLY.test(value)) return value.length >= 32 && entropy(value) >= 3;
  return /\d/.test(value) && /[A-Za-z]/.test(value) && entropy(value) >= 3.8;
}

const pathAllowed = (path: string) => ALLOWED_PATHS.some((a) => a.re.test(path));

export function scanAddedLines(files: AddedFile[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const f of files) {
    const byPath = pathAllowed(f.path);
    for (const { line, text } of f.added) {
      if (text.includes(MARKER)) continue;
      const found = new Set<string>();
      for (const rule of SHAPES) {
        const m = rule.re.exec(text);
        if (!m || rule.skip?.(m[0]) || (byPath && !rule.strict)) continue;
        found.add(rule.id);
        out.push({ path: f.path, line, rule: rule.id, message: `${f.path}:${line}: ${rule.id}: ${rule.hint}. If it is a fixture, move it under test/ or add "${MARKER}: <reason>" on the line.` });
      }
      if (byPath || found.size) continue;
      const a = ASSIGNMENT.exec(text);
      if (a && looksRandom(a[2]!)) {
        out.push({ path: f.path, line, rule: 'secret-literal', message: `${f.path}:${line}: secret-literal: "${a[1]}" is assigned a random-looking literal; read it from env or Secrets Manager. If it is a fixture, move it under test/ or add "${MARKER}: <reason>" on the line.` });
      }
    }
  }
  return out;
}

/** Added lines of a unified diff, with their line numbers in the new file. Deleted files and pure deletions yield nothing. */
export function parseAddedLines(diff: string): AddedFile[] {
  const files: AddedFile[] = [];
  let cur: AddedFile | undefined;
  let inHunk = false;
  let next = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = undefined; inHunk = false; continue; }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) {
        const p = raw.slice(4);
        cur = p === '/dev/null' ? undefined : { path: p.replace(/^b\//, ''), added: [] };
        if (cur) files.push(cur);
      } else if (raw.startsWith('@@')) {
        const m = /\+(\d+)/.exec(raw);
        next = m ? Number(m[1]) : 0;
        inHunk = true;
      }
      continue;
    }
    if (raw.startsWith('@@')) { next = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0); continue; }
    if (raw.startsWith('+')) { cur?.added.push({ line: next, text: raw.slice(1) }); next++; } else if (raw.startsWith(' ')) next++;
  }
  return files.filter((f) => f.added.length);
}
