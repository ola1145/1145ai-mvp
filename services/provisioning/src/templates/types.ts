import { detectInstructionLike } from '../lib/sanitize.js';
import type { BusinessHours } from './spoken.js';
import type { VerticalId } from './verticals.js';

export interface ServiceInfo { id?: string; name: string; durationMin?: number; priceCents?: number; active?: boolean }

/** FACT#<fid> item. Only verified (owner-confirmed) and unflagged facts ever reach a prompt or the knowledge base. */
export interface FactInfo { id: string; text: string; source: string; verified: boolean; flaggedInstructionLike?: boolean }

/** Everything a template may use. All of it is owner-confirmed profile data; none of it is model output. */
export interface RenderContext {
  agentName: string;
  businessName: string;
  businessType?: string;
  vertical: VerticalId;
  timezone: string;
  hours: BusinessHours;
  services: ServiceInfo[];
  facts: FactInfo[];
  /** Tenant-local YYYY-MM-DD, used to drop closed dates that already passed. */
  today?: string;
}

export interface AgentTemplate {
  version: string;
  render(ctx: RenderContext): { instructions: string; disclosureLine: string };
}

export interface RenderedAgent {
  templateVersion: string;
  vertical: VerticalId;
  instructions: string;
  disclosureLine: string;
}

/**
 * Owner free text goes into the prompt on one line, without markup: no control characters, newlines, angle brackets,
 * braces or backticks, so a business name or fact can't open a tag, start a new section or fake a heading.
 */
export function cleanInline(raw: string, max: number): string {
  const s = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[<>{}`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/** Verified by the owner, and not instruction-like (the flag from scraping, re-checked here as a second line). */
export function confirmedFacts(facts: readonly FactInfo[]): FactInfo[] {
  return facts.filter((f) => f.verified === true && !f.flaggedInstructionLike && f.text.trim() && detectInstructionLike(f.text).length === 0);
}
