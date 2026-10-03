import type { Scenario, ScenarioTurn } from './scenarios.js';

export interface TranscriptTurn { role: 'agent' | 'user'; text: string }

export interface AgentInput {
  scenario: Scenario;
  turn: ScenarioTurn;
  turnIndex: number;
  channel: 'voice' | 'chat';
  /** Everything said so far, oldest first, including the greeting. */
  history: readonly TranscriptTurn[];
  userText: string;
}

export interface AgentOutput { reply: string; toolsCalled: string[] }

/**
 * The seam between the runner and an agent under test. CI uses `fakeAdapter`. A live adapter (a LiveKit text
 * session, the AgentCore chat agents) implements the same two methods. Tenant identity comes from the scenario's
 * fixture and caller_id, which an adapter must pass to the agent through the real resolver path, never from text.
 */
export interface AgentAdapter {
  greeting?(scenario: Scenario): Promise<string | undefined>;
  respond(input: AgentInput): Promise<AgentOutput>;
}

/** Replays the scripted `fake` replies from the scenario file. Deterministic, offline, free. */
export const fakeAdapter: AgentAdapter = {
  async greeting(scenario) {
    return scenario.greeting;
  },
  async respond({ turn, scenario, turnIndex }) {
    if (!turn.fake) throw new Error(`no fake reply scripted for ${scenario.id} turn ${turnIndex + 1}`);
    return { reply: turn.fake.reply, toolsCalled: [...turn.fake.tools] };
  },
};
