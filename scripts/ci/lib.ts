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
  return outside.length
    ? { ok: false, message: `[1145:${id}] may only change: ${issue.owns.join(', ')}\nOutside ownership:\n${outside.map((f) => `  - ${f}`).join('\n')}\nFile a change request instead: contracts/CHANGE_REQUESTS/${id}-<n>.md` }
    : { ok: true, message: `${pr.changed.length} file(s) within [1145:${id}] ownership` };
}

/** Contracts and shared types change only with the contract-change label (and CODEOWNERS review). */
export function contractGuard(pr: Pick<PrInfo, 'labels' | 'changed'>): { ok: boolean; message: string } {
  const touched = pr.changed.filter((f) => (f.startsWith('contracts/') && !f.startsWith('contracts/CHANGE_REQUESTS/')) || f.startsWith('packages/shared/'));
  if (!touched.length || pr.labels.includes('contract-change')) return { ok: true, message: touched.length ? 'contract change labelled' : 'no contract changes' };
  return { ok: false, message: `Contract files changed without the "contract-change" label:\n${touched.map((f) => `  - ${f}`).join('\n')}` };
}
