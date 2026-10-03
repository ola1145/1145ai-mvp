import { checkConversation, type StyleIssue } from '../../../packages/conversation-style/src/index.ts';
import type { Channel, Surface, Turn } from './ports.ts';

export const MIN_NATURALNESS = 85;

export interface TurnStyleResult { conversationId: string; surface: Surface; text: string; score: number; issues: StyleIssue[] }
export interface StyleReport { ok: boolean; turns: TurnStyleResult[]; failures: string[]; warnings: string[] }

export const channelOf = (surface: Surface): Channel => (surface === 'phone' ? 'voice' : 'chat');

/**
 * Runs @1145/conversation-style on EVERY agent turn captured in the scenario, per conversation (so repetition and
 * first-turn rules see the right history). Fails on any error-severity issue or a score under 85, same as the eval gate.
 * Also enforces the required AI/recording disclosure on the first agent turn of every phone call.
 * Deterministic rules only; the LLM judge scores tone separately and never decides safety.
 */
export function checkCapturedTurns(turns: readonly Turn[], personNames: Readonly<Record<string, string>> = {}): StyleReport {
  const byConversation = new Map<string, Turn[]>();
  for (const t of turns) byConversation.set(t.conversationId, [...(byConversation.get(t.conversationId) ?? []), t]);

  const results: TurnStyleResult[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const [conversationId, convo] of byConversation) {
    const surface = convo[0]!.surface;
    const checked = checkConversation(convo.map((t) => ({ role: t.role, text: t.text })), channelOf(surface), personNames[conversationId]);
    for (const c of checked) {
      results.push({ conversationId, surface, text: c.text, score: c.score, issues: c.issues });
      const label = `[${conversationId}] "${c.text}"`;
      for (const i of c.issues) {
        if (i.severity === 'error') failures.push(`${label}: ${i.rule} ${i.detail}`);
        else warnings.push(`${label}: ${i.rule} ${i.detail}`);
      }
      if (c.score < MIN_NATURALNESS && !c.issues.some((i) => i.severity === 'error')) failures.push(`${label}: naturalness ${c.score} < ${MIN_NATURALNESS}`);
    }
    if (surface === 'phone') {
      const first = convo.find((t) => t.role === 'agent');
      if (first && !(/\bAI\b/.test(first.text) && /record/i.test(first.text))) failures.push(`[${conversationId}] first spoken turn is missing the AI/recording disclosure: "${first.text}"`);
    }
  }
  return { ok: failures.length === 0, turns: results, failures, warnings };
}
