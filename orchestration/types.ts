export type AgentKind = 'claude' | 'devin' | 'cursor-grok' | 'human';
export type Stream = 'contracts' | 'platform' | 'tool-api' | 'channels' | 'onboarding' | 'voice' | 'agents' | 'post-call' | 'control-plane' | 'quality' | 'ui';

export interface Issue {
  id: string;                 // stable key, appears in Linear title and PR title: [1145:ID]
  title: string;
  stream: Stream;
  agent: AgentKind;
  priority: 1 | 2 | 3 | 4;    // Linear: 1 urgent … 4 low
  owns: string[];             // exact file paths or "dir/**"; no two issues may overlap
  skills: string[];           // .claude/skills/<name>/SKILL.md to load first
  goal: string;
  testsFirst: string[];
  steps: string[];
  acceptance: string[];
  testCmd: string;
  softDeps?: string[];        // informational only; nothing blocks the start
}
