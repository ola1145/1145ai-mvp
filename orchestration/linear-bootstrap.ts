/**
 * Creates (idempotently) the Linear project, labels and one issue per entry in issues.ts, then hands agent issues to
 * Devin and Cursor through their native Linear integrations (assignee = the integration's app user when present,
 * plus the trigger label). Claude issues stay with the orchestrator session. Human issues are assigned to you.
 *
 *   LINEAR_API_KEY=... LINEAR_TEAM_KEY=ENG pnpm orchestrate:bootstrap --dry-run
 *   LINEAR_API_KEY=... LINEAR_TEAM_KEY=ENG pnpm orchestrate:bootstrap
 */
import { writeFileSync } from 'node:fs';
import { renderBrief } from './brief.js';
import { ISSUES } from './issues.js';
import { linear, tag } from './linear.js';
import type { Issue } from './types.js';

const DRY = process.argv.includes('--dry-run');
const TEAM_KEY = process.env.LINEAR_TEAM_KEY ?? 'ENG';
const PROJECT = process.env.LINEAR_PROJECT ?? '1145ai MVP';
// Names as they appear in your Linear workspace after installing the integrations (verify in Settings → Integrations).
const DEVIN_USER = process.env.LINEAR_DEVIN_USER ?? 'Devin';
const CURSOR_USER = process.env.LINEAR_CURSOR_USER ?? 'Cursor';
const LABELS: Record<string, string> = {
  'agent:claude': '#D97757', 'agent:devin': '#4F46E5', 'agent:cursor-grok': '#111827', 'agent:human': '#16A34A',
  'contract-change': '#DC2626', 'conversation-quality': '#F59E0B',
  [process.env.DEVIN_TRIGGER_LABEL ?? 'Devin']: '#4F46E5',
};

async function main() {
  const { teams } = await linear<{ teams: { nodes: Array<{ id: string; key: string }> } }>('query { teams { nodes { id key } } }');
  const team = teams.nodes.find((t) => t.key === TEAM_KEY);
  if (!team) throw new Error(`team ${TEAM_KEY} not found; set LINEAR_TEAM_KEY`);

  const { users } = await linear<{ users: { nodes: Array<{ id: string; name: string; displayName: string; isMe: boolean }> } }>('query { users { nodes { id name displayName isMe } } }');
  const findUser = (n: string) => users.nodes.find((u) => [u.name, u.displayName].some((x) => x?.toLowerCase() === n.toLowerCase()));
  const me = users.nodes.find((u) => u.isMe);
  const devin = findUser(DEVIN_USER);
  const cursor = findUser(CURSOR_USER);
  console.log(`team ${team.key} · Devin user: ${devin ? 'found' : 'NOT FOUND (install Devin in Linear)'} · Cursor user: ${cursor ? 'found' : 'NOT FOUND (install Cursor in Linear)'}`);

  const { projects } = await linear<{ projects: { nodes: Array<{ id: string; name: string; url: string }> } }>('query($n: String!) { projects(filter: { name: { eq: $n } }) { nodes { id name url } } }', { n: PROJECT });
  let project = projects.nodes[0];
  if (!project && !DRY) {
    project = (await linear<{ projectCreate: { project: { id: string; name: string; url: string } } }>(
      'mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { project { id name url } } }',
      { i: { name: PROJECT, teamIds: [team.id], description: 'AI front desk MVP. All issues run in parallel except UI. Source: orchestration/issues.ts' } },
    )).projectCreate.project;
  }

  const labelIds: Record<string, string> = {};
  const { issueLabels } = await linear<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>('query { issueLabels(first: 250) { nodes { id name } } }');
  for (const [name, color] of Object.entries({ ...LABELS, ...Object.fromEntries(ISSUES.map((i) => [`stream:${i.stream}`, '#6B7280'])) })) {
    const hit = issueLabels.nodes.find((l) => l.name === name);
    if (hit) { labelIds[name] = hit.id; continue; }
    if (DRY) continue;
    labelIds[name] = (await linear<{ issueLabelCreate: { issueLabel: { id: string } } }>(
      'mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { issueLabel { id } } }', { i: { name, color, teamId: team.id } },
    )).issueLabelCreate.issueLabel.id;
  }

  const map: Record<string, { identifier: string; url: string; agent: Issue['agent'] }> = {};
  for (const i of ISSUES) {
    const { issues } = await linear<{ issues: { nodes: Array<{ id: string; identifier: string; url: string }> } }>(
      'query($q: String!) { issues(filter: { title: { startsWith: $q } }) { nodes { id identifier url } } }', { q: tag(i.id) });
    if (issues.nodes[0]) { map[i.id] = { ...issues.nodes[0], agent: i.agent }; continue; }
    const assignee = i.agent === 'devin' ? devin : i.agent === 'cursor-grok' ? cursor : i.agent === 'human' ? me : undefined;
    const labels = [`agent:${i.agent}`, `stream:${i.stream}`, ...(i.agent === 'devin' ? [process.env.DEVIN_TRIGGER_LABEL ?? 'Devin'] : [])];
    if (DRY) { console.log(`would create ${tag(i.id)} ${i.title} -> ${i.agent}${assignee ? ` (assignee ${assignee.name})` : ''}`); continue; }
    const created = (await linear<{ issueCreate: { issue: { id: string; identifier: string; url: string } } }>(
      'mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { id identifier url } } }',
      { i: { teamId: team.id, projectId: project?.id, title: `${tag(i.id)} ${i.title}`, description: renderBrief(i), priority: i.priority,
        labelIds: labels.map((l) => labelIds[l]).filter(Boolean), assigneeId: assignee?.id } },
    )).issueCreate.issue;
    map[i.id] = { ...created, agent: i.agent };
    console.log(`created ${created.identifier} ${tag(i.id)} -> ${i.agent}`);
  }
  if (!DRY) writeFileSync('orchestration/.linear-map.json', JSON.stringify({ project: project?.url, issues: map }, null, 2));
  console.log(DRY ? 'dry run complete' : `done: ${Object.keys(map).length} issues · ${project?.url}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
