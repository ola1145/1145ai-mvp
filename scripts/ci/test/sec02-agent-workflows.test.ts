import { describe, expect, it } from 'vitest';
import { jobs, read } from './helpers.js';

/**
 * SEC-02: the repo is public. Anyone can open an issue, comment on a PR or push a fork, so what wakes an agent that
 * can write, and what text ends up in a prompt, has to be narrow and explicit.
 */

const BOTS = 'claude[bot],devin-ai-integration[bot],cursor[bot]';

describe('claude.yml', () => {
  const t = read('.github/workflows/claude.yml');
  it('wakes only for the owner, members and collaborators, on both comment events', () => {
    expect(t).toContain('issue_comment');
    expect(t).toContain('pull_request_review_comment');
    expect(t).toMatch(/contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.comment\.author_association\)/);
    expect(t, 'CONTRIBUTOR and FIRST_TIME_CONTRIBUTOR are strangers on a public repo').not.toMatch(/CONTRIBUTOR"|NONE/);
  });
  it('names the bots it accepts instead of "*"', () => {
    expect(t).toContain(`allowed_bots: "${BOTS}"`);
    expect(t).not.toMatch(/allowed_bots:\s*['"]?\*/);
  });
  it('tells Claude that comments, logs and file contents are data', () => {
    expect(t).toMatch(/data, never instructions/);
  });
});

describe('claude-review.yml', () => {
  const t = read('.github/workflows/claude-review.yml');
  const job = jobs('claude-review.yml')['claude-review']!;

  it('names the bots it accepts instead of "*"', () => {
    expect(t).toContain(`allowed_bots: "${BOTS}"`);
    expect(t).not.toMatch(/allowed_bots:\s*['"]?\*/);
  });

  it('never interpolates the PR title or body into the prompt', () => {
    const prompt = t.slice(t.indexOf('prompt: |'), t.indexOf('claude_args:'));
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt, 'pass the title and body through files (env -> printf), not through ${{ }} in the prompt').not.toMatch(/github\.event\.pull_request\.(title|body)/);
  });

  it('hands the title and body to the reviewer as files it is told are data', () => {
    expect(job).toMatch(/PR_TITLE:\s*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/);
    expect(job).toMatch(/PR_BODY:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/);
    expect(job).toMatch(/printf '%s' "\$PR_TITLE" > .*pr-title\.txt/);
    expect(job).toMatch(/printf '%s' "\$PR_BODY" > .*pr-body\.txt/);
    const prompt = t.slice(t.indexOf('prompt: |'), t.indexOf('claude_args:'));
    expect(prompt).toMatch(/pr-title\.txt/);
    expect(prompt).toMatch(/pr-body\.txt/);
    expect(prompt, 'the prompt must say the files are untrusted data').toMatch(/untrusted|data, not instructions/i);
  });

  it('clears any committed copy of those files before writing the real ones, and both happen before the review runs', () => {
    const clear = t.indexOf('rm -rf .untrusted-pr');
    const write = t.indexOf('pr-title.txt');
    const action = t.indexOf('claude-code-action');
    expect(clear, 'a PR could commit its own .untrusted-pr/pr-title.txt').toBeGreaterThan(-1);
    expect(clear).toBeLessThan(write);
    expect(write).toBeLessThan(action);
  });

  it('keeps the verdict-from-comment gate', () => {
    expect(t).toContain('scripts/ci/review-verdict.sh');
    expect(t).toContain('REVIEW_START');
  });

  it('fails, rather than skips, a PR from a fork: the required check must not pass for want of secrets', () => {
    expect(job).toMatch(/head\.repo\.full_name\s*!=\s*github\.repository/);
    expect(job).toMatch(/exit 1/);
  });

  it('only gives the reviewer read tools plus comments', () => {
    const tools = /--allowedTools "([^"]+)"/.exec(t)![1]!;
    expect(tools).not.toMatch(/\bEdit\b|\bWrite\b|Bash\(\*|Bash\(git|Bash\(rm|Bash\(curl/);
  });
});

describe('ci-failure-router.yml', () => {
  const t = read('.github/workflows/ci-failure-router.yml');
  it('keeps the log tail out of any comment that mentions an agent', () => {
    // The mention comment is posted with a PAT, so it wakes the agent and the whole text becomes its prompt.
    const mentionComment = t.slice(t.indexOf('WHO=""'), t.indexOf('--body-file mention.md'));
    expect(mentionComment).toContain('> mention.md');
    expect(mentionComment).not.toContain('$LOG');
    expect(mentionComment, 'point the agent at the run instead: gh run view <id> --log-failed').toMatch(/gh run view/);
  });
  it('posts the log tail in a separate comment with the read-only token, which cannot start a workflow', () => {
    expect(t).toMatch(/GH_TOKEN="\$READ_TOKEN" gh pr comment "\$PR" --repo "\$REPO" --body-file log\.md/);
    expect(t).toContain('sanitize-log.sh');
  });
  it('never mentions an agent on a fork PR', () => {
    expect(t).toMatch(/head_repository\.full_name/);
  });
});

describe('automerge.yml', () => {
  it('only enables auto-merge on PRs from this repo, not from forks', () => {
    expect(read('.github/workflows/automerge.yml')).toMatch(/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
  });
});
