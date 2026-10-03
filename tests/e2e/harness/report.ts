import type { GateReport } from './gate.ts';

const ICON = { pass: 'PASS', fail: 'FAIL', skipped: 'skip' } as const;

/** Markdown for $GITHUB_STEP_SUMMARY and for the PR / Linear summary comment. */
export function renderSummary(report: GateReport): string {
  const lines = [`## Gate e2e: ${report.ok ? 'PASS' : 'FAIL'}`, '', '| Step | Result | Detail |', '|---|---|---|'];
  for (const s of report.steps) lines.push(`| ${s.id} | ${ICON[s.status]} | ${(s.detail ?? '').replace(/\|/g, '\\|')} |`);
  const agentTurns = report.style.turns.length;
  const worst = report.style.turns.reduce((m, t) => Math.min(m, t.score), 100);
  lines.push('', `Conversation style: ${agentTurns} agent turns checked, lowest naturalness ${agentTurns ? worst : 'n/a'}, ${report.style.failures.length} failure(s), ${report.style.warnings.length} warning(s).`);
  if (report.style.failures.length) lines.push('', 'Style failures:', ...report.style.failures.map((f) => `- ${f}`));
  if (report.style.warnings.length) lines.push('', 'Style warnings:', ...report.style.warnings.map((f) => `- ${f}`));
  return lines.join('\n') + '\n';
}
