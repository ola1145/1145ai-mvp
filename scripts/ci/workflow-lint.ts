/**
 * A small, dependency-free lint for .github/workflows/*.yml. It is not actionlint; it enforces the handful of rules that
 * keep a public repo's pipeline from being steered by outsiders (threat model SEC-02, SEC-03):
 *   unpinned-action          every `uses:` is a full commit sha (tags and branches can be moved under us)
 *   allow-all-bots           `allowed_bots: "*"` lets any GitHub App wake an agent that can write
 *   untrusted-expression     PR titles, bodies, comments, branch names and commit messages go through `env:`, never into a script or prompt
 *   missing-permissions      every workflow declares its token permissions at the top
 * Each issue is one line: where it is and what to change.
 */
export interface LintIssue { file: string; line: number; rule: string; message: string }

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Event fields an outsider controls. Matched inside `${{ ... }}` only. */
const UNTRUSTED = [
  'github\\.event\\.pull_request\\.(?:title|body|head\\.ref|head\\.label|head\\.repo\\.full_name)',
  'github\\.event\\.issue\\.(?:title|body)',
  'github\\.event\\.(?:comment|review)\\.body',
  'github\\.event\\.commits\\.[^}]*?\\.(?:message|author\\.(?:name|email))',
  'github\\.event\\.head_commit\\.(?:message|author\\.(?:name|email))',
  'github\\.event\\.workflow_run\\.(?:head_branch|display_title|head_commit\\.(?:message|author\\.(?:name|email))|pull_requests\\.[^}]*?\\.head\\.ref)',
  'github\\.head_ref',
];
const UNTRUSTED_EXPR = new RegExp(`\\$\\{\\{[^}]*?(?:${UNTRUSTED.join('|')})[^}]*\\}\\}`);

/** Keys whose value is a shell script or a prompt, so an expression there is spliced in as text. */
const SCRIPT_KEYS = new Set(['run', 'prompt', 'script', 'claude_args', 'args', 'custom_instructions', 'direct_prompt', 'override_prompt']);

const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

export function lintWorkflow(file: string, text: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (line: number, rule: string, message: string) => issues.push({ file, line, rule, message });
  const lines = text.split('\n');

  if (!lines.some((l) => /^permissions:/.test(l))) {
    add(1, 'missing-permissions', 'add a top-level "permissions:" block (start from "contents: read") so the token only gets what the jobs need');
  }

  let block: { key: string; column: number } | undefined;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const noComment = raw.replace(/\s+#.*$/, '');

    // A literal block (`run: |`) ends at the first non-blank line indented no deeper than its key.
    if (block) {
      const indent = raw.length - raw.trimStart().length;
      if (raw.trim() === '' || indent > block.column) {
        if (UNTRUSTED_EXPR.test(raw)) add(n, 'untrusted-expression', `${block.key}: pass "${UNTRUSTED_EXPR.exec(raw)![0]}" through env: and read the variable, so the text is data and not part of the ${block.key === 'run' ? 'script' : 'prompt'}`);
        return;
      }
      block = undefined;
    }

    const uses = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s]+)/.exec(noComment);
    if (uses) {
      const ref = uses[1]!;
      if (ref.startsWith('./')) return;
      if (ref.startsWith('docker://')) {
        if (!DIGEST.test(ref.split('@')[1] ?? '')) add(n, 'unpinned-action', `pin ${ref} to an image digest (docker://image@sha256:...)`);
        return;
      }
      const at = ref.lastIndexOf('@');
      const pin = at === -1 ? '' : ref.slice(at + 1);
      if (!FULL_SHA.test(pin)) {
        const action = at === -1 ? ref : ref.slice(0, at);
        add(n, 'unpinned-action', `pin ${action} to a commit sha: git ls-remote https://github.com/${action.split('/').slice(0, 2).join('/')} refs/tags/<tag> (the ^{} line for annotated tags), then "@<sha> # <tag>"`);
      }
      return;
    }

    if (/^\s*allowed_bots:\s*['"]?\*['"]?\s*$/.test(noComment)) {
      add(n, 'allow-all-bots', 'name the bots instead of "*": allowed_bots: "claude[bot],devin-ai-integration[bot],cursor[bot]"');
      return;
    }

    const m = KEY_LINE.exec(noComment);
    if (!m || !SCRIPT_KEYS.has(m[3]!)) return;
    const value = (m[4] ?? '').trim();
    const column = m[1]!.length + (m[2]?.length ?? 0);
    if (/^[|>][+-]?\d*$/.test(value)) { block = { key: m[3]!, column }; return; }
    if (UNTRUSTED_EXPR.test(raw)) add(n, 'untrusted-expression', `${m[3]}: pass "${UNTRUSTED_EXPR.exec(raw)![0]}" through env: and read the variable, so the text is data and not part of the ${m[3] === 'run' ? 'script' : 'prompt'}`);
  });
  return issues;
}
