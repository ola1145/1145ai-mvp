/**
 * Stands in for the nightly job's live module (EVALS_LIVE_MODULE). A real one builds an adapter that drives the
 * LiveKit text session or the AgentCore agents with the scenario's `api` fixture, and an LlmJudge on Bedrock.
 * This stub replays the scripted fakes and tags its judge so the CLI test can tell which path ran. No network.
 */
import { fakeAdapter, type AgentAdapter } from '../../src/adapters.js';
import type { Judge } from '../../src/judge.js';

export async function createLive(): Promise<{ adapter: AgentAdapter; judge: Judge }> {
  return { adapter: fakeAdapter, judge: { score: async () => ({ warmth: 5, brevity: 5, notes: 'stub-live' }) } };
}
