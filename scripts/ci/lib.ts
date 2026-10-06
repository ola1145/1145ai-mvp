import { ISSUES } from '../../orchestration/issues.js';
import { outsideOwnership } from '../../orchestration/ownership.js';

export function prTag(title: string): string | undefined {
  return /^\s*\[1145:([A-Z]\d{1,2})\]/.exec(title)?.[1];
}

export interface PrInfo { title: string; labels: string[]; author: string; changed: string[]; repoOwner: string }

/** Ownership: every changed file must belong to the PR's issue. Lanes may always add their own change requests. */
export function ownershipViolations(pr: PrInfo): { ok: boolean; message: string } {
  if (pr.labels.includes('orchestrator') && pr.author === pr.repoOwner) return { ok: true, message: 'orchestrator PR by repo owner: exempt' };
  const id = prTag(pr.title);
  if (!id) return { ok: false, message: 'PR title must start with [1145:<ID>] (e.g. "[1145:T1] reschedule handler")' };
  const issue = ISSUES.find((i) => i.id === id);
  if (!issue) return { ok: false, message: `unknown issue id ${id}` };
  const allowed = (f: string) => f.startsWith(`contracts/CHANGE_REQUESTS/${id}-`);
  const outside = outsideOwnership(issue.owns, pr.changed, allowed);
  if (!outside.length) return { ok: true, message: `${pr.changed.length} file(s) within [1145:${id}] ownership` };
  const deps = outside.some(isDependencyFile)
    ? `\nDependency lists and lockfiles belong to P3. Ask for a package with "Kind: dependency" and a line like "- npm: \`name@range\` in <dir>" in contracts/CHANGE_REQUESTS/${id}-<n>.md.`
    : '';
  return {
    ok: false,
    message: `[1145:${id}] may only change: ${issue.owns.join(', ')}\nOutside ownership:\n${outside.map((f) => `  - ${f}`).join('\n')}\nFile a change request instead: contracts/CHANGE_REQUESTS/${id}-<n>.md${deps}`,
  };
}

const isDependencyFile = (f: string) => /(^|\/)(pnpm-lock\.yaml|uv\.lock|package\.json|pyproject\.toml|pnpm-workspace\.yaml)$/.test(f);

/** Contracts and shared types change only with the contract-change label (and CODEOWNERS review). */
export function contractGuard(pr: Pick<PrInfo, 'labels' | 'changed'>): { ok: boolean; message: string } {
  const touched = pr.changed.filter((f) => (f.startsWith('contracts/') && !f.startsWith('contracts/CHANGE_REQUESTS/')) || f.startsWith('packages/shared/'));
  if (!touched.length || pr.labels.includes('contract-change')) return { ok: true, message: touched.length ? 'contract change labelled' : 'no contract changes' };
  return { ok: false, message: `Contract files changed without the "contract-change" label (add it, or file contracts/CHANGE_REQUESTS/<ID>-<n>.md instead):\n${touched.map((f) => `  - ${f}`).join('\n')}` };
}

export interface ChangeRequestFile { path: string; text: string }
export interface DepRequest { from: string; where: string; range: string }
export interface DepBatchEntry { name: string; ecosystem: 'npm' | 'uv'; requests: DepRequest[] }

const crId = (path: string) => /([A-Z]\d{1,2}-\d+)\.md$/.exec(path)?.[1];
const isDepRequest = (text: string) => /^\s*Kind:\s*dependency\s*$/im.test(text);
// "- npm: `zod@^3.23.0` in services/tool-api"  or  "- uv: `httpx>=0.27` in engines/livekit-agent"
const DEP_LINE = /^\s*[-*]\s*(npm|uv):\s*`(@?[^`@\s<>=~^!]+)(?:@|(?=[<>=~^!]))([^`]*)`\s+in\s+(\S+)\s*$/;

/** Dependency requests from CHANGE_REQUESTS, grouped by package, for P3's one-PR-a-day lockfile batch. */
export function parseDepRequests(files: ChangeRequestFile[]): DepBatchEntry[] {
  const byKey = new Map<string, DepBatchEntry>();
  for (const f of files) {
    const from = crId(f.path);
    if (!from || !isDepRequest(f.text)) continue;
    for (const line of f.text.split('\n')) {
      const m = DEP_LINE.exec(line);
      if (!m) continue;
      const eco = m[1] as 'npm' | 'uv';
      const key = `${eco}:${m[2]}`;
      const entry = byKey.get(key) ?? { name: m[2]!, ecosystem: eco, requests: [] };
      entry.requests.push({ from, where: m[4]!, range: m[3]! });
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Ids of dependency requests with no readable package line, so P3 can ask the author to fix the format. */
export function unparsedDepRequests(files: ChangeRequestFile[]): string[] {
  return files.flatMap((f) => {
    const from = crId(f.path);
    return from && isDepRequest(f.text) && !f.text.split('\n').some((l) => DEP_LINE.test(l)) ? [from] : [];
  });
}

export function renderDepBatch(batch: DepBatchEntry[]): string {
  if (!batch.length) return 'No dependency requests today.';
  return batch
    .map((b) => `- **${b.name}** (${b.ecosystem}): ${b.requests.map((r) => `${r.from} wants ${r.range || 'latest'} in ${r.where}`).sort().join('; ')}`)
    .join('\n');
}
