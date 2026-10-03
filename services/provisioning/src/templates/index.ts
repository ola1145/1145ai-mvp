/**
 * Agent template registry. Template text lives in code (reviewed, tested, evaluated); release metadata lives in
 * TEMPLATE#<name> / V#<semver> items (status, canary %). A tenant pins the version it was first rendered with and
 * stays on it until someone moves it deliberately, so one bad prompt change never hits every tenant at once.
 */
import { createHash } from 'node:crypto';
import type { AgentTemplate, RenderContext, RenderedAgent } from './types.js';
import { v0_1_0 } from './v0-1-0.js';

export { VERTICALS, describeBusiness, verticalFor, withArticle, type VerticalId, type VerticalVocab } from './verticals.js';
export { confirmedFacts, cleanInline, type FactInfo, type ServiceInfo, type RenderContext, type RenderedAgent } from './types.js';
export { DEFAULT_AGENT_NAME } from './v0-1-0.js';
export type { BusinessHours, DayHours } from './spoken.js';

export const TEMPLATE_NAME = 'frontdesk';

export const TEMPLATES: Readonly<Record<string, AgentTemplate>> = {
  [v0_1_0.version]: v0_1_0,
};

export interface TemplateRelease {
  version: string;
  status: 'stable' | 'canary' | 'retired';
  /** Share of new (unpinned) tenants, 0..100, that get this canary. */
  canaryPercent?: number;
}

/** Used when no release items exist yet. */
export const DEFAULT_RELEASES: readonly TemplateRelease[] = [{ version: '0.1.0', status: 'stable' }];

function semverCmp(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Stable 0..99 bucket per tenant, so the canary cohort doesn't reshuffle between renders or releases. */
export function canaryBucket(tenantId: string): number {
  return createHash('sha256').update(`template-canary:${tenantId}`).digest().readUInt32BE(0) % 100;
}

export interface SelectVersionInput {
  tenantId: string;
  /** PROFILE.templateVersion. Set after the first render; always wins. */
  pinned?: string;
  releases: readonly TemplateRelease[];
  /** Versions that have template code. Defaults to the registry. */
  available?: readonly string[];
}

export function selectTemplateVersion({ tenantId, pinned, releases, available = Object.keys(TEMPLATES) }: SelectVersionInput): string {
  if (pinned) {
    if (!available.includes(pinned)) throw new Error(`TemplateVersionMissing: tenant is pinned to ${pinned}, which has no template code`);
    return pinned;
  }
  const usable = releases.filter((r) => available.includes(r.version) && r.status !== 'retired');
  const newest = (status: TemplateRelease['status']) =>
    usable.filter((r) => r.status === status).sort((a, b) => semverCmp(b.version, a.version))[0];
  const stable = newest('stable');
  const canary = usable
    .filter((r) => r.status === 'canary' && (r.canaryPercent ?? 0) > 0 && (!stable || semverCmp(r.version, stable.version) > 0))
    .sort((a, b) => semverCmp(b.version, a.version))[0];
  if (canary && canaryBucket(tenantId) < Math.min(100, canary.canaryPercent ?? 0)) return canary.version;
  if (!stable) throw new Error('NoStableTemplate: no stable template release with code');
  return stable.version;
}

export function renderTemplate(version: string, ctx: RenderContext): RenderedAgent {
  const t = TEMPLATES[version];
  if (!t) throw new Error(`TemplateVersionMissing: ${version}`);
  const { instructions, disclosureLine } = t.render(ctx);
  return { templateVersion: t.version, vertical: ctx.vertical, instructions, disclosureLine };
}
