/**
 * Fallback launcher when a Linear integration does not pick an issue up (or to burst past it).
 *  - devin: POST https://api.devin.ai/v1/sessions  (DEVIN_API_KEY)
 *  - cursor-grok: POST https://api.cursor.com/v0/agents  (CURSOR_API_KEY, model from CURSOR_AGENT_MODEL)
 *  - claude: printed for the orchestrator session (it runs them as worktree-isolated subagents)
 * Verify both vendor endpoints/payloads against current docs before the first run; every call is opt-in per flag.
 *
 *   pnpm orchestrate:dispatch --agent devin --ids P1,P2 [--dry-run]
 *   pnpm orchestrate:dispatch --agent cursor-grok --all --max 22
 */
import { readFileSync } from 'node:fs';
import { renderBrief } from './brief.js';
import { ISSUES } from './issues.js';
import type { Issue } from './types.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const DRY = process.argv.includes('--dry-run');
const AGENT = arg('--agent') as Issue['agent'] | undefined;
const IDS = arg('--ids')?.split(',');
const MAX = Number(arg('--max') ?? 50);
const REPO = process.env.GITHUB_REPO_URL ?? 'https://github.com/OWNER/1145ai-mvp';

let linearMap: Record<string, { url: string }> = {};
try { linearMap = JSON.parse(readFileSync('orchestration/.linear-map.json', 'utf8')).issues; } catch { /* bootstrap not run yet */ }

function prompt(i: Issue): string {
  const link = linearMap[i.id]?.url ? `Linear issue: ${linearMap[i.id]!.url} (update its status and comment your PR link there).\n` : '';
  return `${link}Repository: ${REPO} (branch from main).\n\n${renderBrief(i)}`;
}

async function launchDevin(i: Issue) {
  const r = await fetch('https://api.devin.ai/v1/sessions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.DEVIN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt(i), idempotent: true, title: `[1145:${i.id}] ${i.title}` }),
  });
  const b = (await r.json()) as { session_id?: string; url?: string };
  if (!r.ok) throw new Error(`devin ${r.status} ${JSON.stringify(b)}`);
  return b.url ?? b.session_id;
}

async function launchCursor(i: Issue) {
  const r = await fetch('https://api.cursor.com/v0/agents', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.CURSOR_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: { text: prompt(i) },
      source: { repository: REPO, ref: 'main' },
      model: process.env.CURSOR_AGENT_MODEL ?? 'grok-code-fast-1',
      target: { autoCreatePr: true, branchName: `cursor/1145-${i.id.toLowerCase()}` },
    }),
  });
  const b = (await r.json()) as { id?: string; target?: { url?: string } };
  if (!r.ok) throw new Error(`cursor ${r.status} ${JSON.stringify(b)}`);
  return b.target?.url ?? b.id;
}

async function main() {
  const picked = ISSUES.filter((i) => (!AGENT || i.agent === AGENT) && (process.argv.includes('--all') || IDS?.includes(i.id)) && i.agent !== 'human').slice(0, MAX);
  if (!picked.length) { console.log('nothing selected (use --all or --ids)'); return; }
  const results = await Promise.allSettled(picked.map(async (i) => {
    if (DRY || i.agent === 'claude') return `${i.agent === 'claude' ? 'orchestrator' : 'dry-run'}: ${i.id}`;
    return i.agent === 'devin' ? launchDevin(i) : launchCursor(i);
  }));
  results.forEach((r, n) => console.log(`${picked[n]!.id.padEnd(4)} ${picked[n]!.agent.padEnd(12)} ${r.status === 'fulfilled' ? r.value : `FAILED ${String(r.reason)}`}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
