import { checkReply, naturalnessScore } from '../../packages/conversation-style/src/index.js';
import type { AgentAdapter, AgentOutput, TranscriptTurn } from './adapters.js';
import type { Judge } from './judge.js';
import type { Expect, Scenario } from './scenarios.js';
import { toolMatches } from './tools.js';

export type FailureKind = 'style' | 'expect' | 'judge' | 'adapter';
export interface Failure { scenario: string; kind: FailureKind; detail: string; turn?: number; run?: number }

export interface JudgeSummary { warmth: number; brevity: number; average: number; notes: string }

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  runs: number;
  passedRuns: number;
  failures: Failure[];
  judge?: JudgeSummary;
  /**
   * Onboarding: owner messages until name_agent and provisioning_status had both been called (worst run).
   * Undefined when setup never finished.
   */
  ownerMessagesToComplete?: number;
  /** Transcript of the last run, for debugging a failure. */
  transcript: TranscriptTurn[];
}

export interface RunOptions {
  adapter: AgentAdapter;
  judge: Judge;
  /** The template-activation gate is 5 of 5 runs. CI uses 1 to 2. */
  runs?: number;
  /** Average of warmth and brevity must reach this. Default 4. */
  minJudgeAverage?: number;
  /** Per-turn naturalness gate. Default 85. */
  minNaturalness?: number;
  /** A2 acceptance: the median onboarding must finish in fewer owner messages than this. Default 12. */
  maxOnboardingMedian?: number;
}

export interface SuiteResult {
  passed: boolean;
  results: ScenarioResult[];
  failures: Failure[];
  /** Gates over the whole suite (judge average, onboarding median) that failed. */
  suiteFailures: string[];
  judgeAverage: number;
  /**
   * Median owner messages to finish onboarding, over the scenarios that set max_owner_messages_to_complete.
   * A flow that never finished counts as Infinity. Undefined when no scenario sets a budget.
   */
  onboardingMedianMessages?: number;
}

const MIN_JUDGE = 4;
const MIN_NATURAL = 85;
const MAX_ONBOARDING_MEDIAN = 12;
/** Onboarding is done once the receptionist is named and the owner has been given the number. */
const COMPLETION_TOOLS = ['name_agent', 'provisioning_status'];

/** Case-insensitive; very short word-like tokens ("AI", "Tue") must match as whole words. */
function has(text: string, needle: string): boolean {
  if (/^\w{1,3}$/.test(needle)) return new RegExp(`\\b${needle}\\b`, 'i').test(text);
  return text.toLowerCase().includes(needle.toLowerCase());
}

const VERIFICATION = /\b(?:verify|verification|last name|code|on file|digits|spell|booked under|which (?:name|number))\b/i;

/** The first sentence of the first line: what someone reads before deciding whether the answer is there. */
export function firstSentence(reply: string): string {
  const line = reply.trim().split('\n')[0] ?? '';
  return line.split(/(?<=[.!?])\s+/)[0] ?? '';
}

function checkExpect(expect: Expect, out: AgentOutput): string[] {
  const { reply, toolsCalled: tools } = out;
  const issues: string[] = [];
  const called = tools.join(', ') || 'none';
  if (expect.tools_called && expect.tools_called.length === 0 && tools.length) issues.push(`expected no tools to be called (called: ${called})`);
  for (const t of expect.tools_called ?? []) if (!tools.some((x) => toolMatches(t, x))) issues.push(`expected tool ${t} to be called (called: ${called})`);
  for (const t of expect.tools_not_called ?? []) {
    const hit = tools.filter((x) => toolMatches(t, x));
    if (hit.length) issues.push(`tool ${t} must not be called (called: ${hit.join(', ')})`);
  }
  for (const s of expect.reply_contains ?? []) if (!has(reply, s)) issues.push(`reply should contain "${s}"`);
  if (expect.reply_contains_any?.length && !expect.reply_contains_any.some((s) => has(reply, s))) {
    issues.push(`reply should contain one of ${expect.reply_contains_any.map((s) => `"${s}"`).join(', ')}`);
  }
  if (expect.first_sentence_contains_any?.length) {
    const first = firstSentence(reply);
    if (!expect.first_sentence_contains_any.some((s) => has(first, s))) {
      issues.push(`first sentence should carry the answer (one of ${expect.first_sentence_contains_any.map((s) => `"${s}"`).join(', ')}): "${first}"`);
    }
  }
  for (const s of expect.reply_not_contains ?? []) if (has(reply, s)) issues.push(`reply must not contain "${s}"`);
  if (expect.api_paths_not_contains?.length) {
    if (!out.apiPaths) issues.push('the adapter did not report API paths, so api_paths_not_contains cannot be checked');
    else {
      for (const s of expect.api_paths_not_contains) {
        const bad = out.apiPaths.filter((p) => p.includes(s));
        if (bad.length) issues.push(`a tool call left the routed scope: ${bad.join(', ')} contains "${s}"`);
      }
    }
  }
  if (expect.reply_max_chars !== undefined && reply.length > expect.reply_max_chars) issues.push(`reply is ${reply.length} chars, max ${expect.reply_max_chars}`);
  const wordCount = reply.trim().split(/\s+/).filter(Boolean).length;
  if (expect.reply_max_words !== undefined && wordCount > expect.reply_max_words) issues.push(`reply is ${wordCount} words, max ${expect.reply_max_words}`);
  if (expect.reply_asks_for_verification && !VERIFICATION.test(reply)) issues.push('reply should ask the person to verify before acting');
  return issues;
}

interface OneRun { failures: Failure[]; transcript: TranscriptTurn[]; judge?: JudgeSummary; ownerMessagesToComplete?: number }

async function oneRun(s: Scenario, opts: RunOptions, run: number): Promise<OneRun> {
  const failures: Failure[] = [];
  const fail = (kind: FailureKind, detail: string, turn?: number) => failures.push({ scenario: s.id, kind, detail, turn, run });
  const transcript: TranscriptTurn[] = [];
  const agentTurns: string[] = [];
  const minNatural = opts.minNaturalness ?? MIN_NATURAL;

  const styleCheck = (text: string, turn: number) => {
    const issues = checkReply(text, {
      channel: s.styleChannel,
      previousAgentTurns: agentTurns,
      isFirstTurn: agentTurns.length === 0,
      requireDisclosure: s.styleChannel === 'voice',
    });
    for (const i of issues) if (i.severity === 'error') fail('style', `${i.rule}: ${i.detail}${i.rule === 'missing-disclosure' ? ' (AI/recording disclosure)' : ''}`, turn);
    const score = naturalnessScore(issues);
    if (score < minNatural) fail('style', `naturalness ${score} < ${minNatural} (${issues.map((i) => i.rule).join(', ')})`, turn);
    agentTurns.push(text);
  };

  // The opening line. Voice calls must open with the AI and recording disclosure.
  let greeting: string | undefined;
  try { greeting = await opts.adapter.greeting?.(s); } catch (e) { fail('adapter', `greeting failed: ${(e as Error).message}`); return { failures, transcript }; }
  if (greeting !== undefined) {
    transcript.push({ role: 'agent', text: greeting });
    styleCheck(greeting, 0);
  } else if (s.styleChannel === 'voice') {
    fail('expect', 'voice scenarios need a greeting so the disclosure can be checked');
  }
  for (const needle of s.firstUtteranceContains) {
    if (greeting === undefined || !has(greeting, needle)) fail('expect', `first utterance should contain "${needle}"`);
  }

  const toolsSoFar = new Set<string>();
  let ownerMessages = 0;
  let ownerMessagesToComplete: number | undefined;
  for (let i = 0; i < s.turns.length; i++) {
    const turn = s.turns[i]!;
    let out: AgentOutput;
    try {
      out = await opts.adapter.respond({ scenario: s, turn, turnIndex: i, channel: s.styleChannel, history: [...transcript], userText: turn.text });
    } catch (e) {
      fail('adapter', (e as Error).message, i + 1);
      break;
    }
    transcript.push({ role: 'user', text: turn.text }, { role: 'agent', text: out.reply });
    for (const d of checkExpect(turn.expect, out)) fail('expect', d, i + 1);
    styleCheck(out.reply, i + 1);
    if (turn.speaker === 'owner') ownerMessages++;
    for (const t of out.toolsCalled) toolsSoFar.add(t);
    if (ownerMessagesToComplete === undefined && s.agent === 'onboarding' && COMPLETION_TOOLS.every((t) => toolsSoFar.has(t))) ownerMessagesToComplete = ownerMessages;
  }
  const budget = s.maxOwnerMessagesToComplete;
  if (budget !== undefined) {
    if (ownerMessagesToComplete === undefined) fail('expect', `setup never finished (name_agent and provisioning_status) in ${ownerMessages} owner messages; budget ${budget}`);
    else if (ownerMessagesToComplete > budget) fail('expect', `setup took ${ownerMessagesToComplete} owner messages; budget ${budget}`);
  }

  let judge: JudgeSummary | undefined;
  try {
    const sc = await opts.judge.score({ channel: s.styleChannel, turns: transcript });
    const average = Math.round(((sc.warmth + sc.brevity) / 2) * 100) / 100;
    judge = { ...sc, average };
    const min = opts.minJudgeAverage ?? MIN_JUDGE;
    if (average < min) fail('judge', `tone average ${average} < ${min} (warmth ${sc.warmth}, brevity ${sc.brevity}${sc.notes ? `: ${sc.notes}` : ''})`);
  } catch (e) {
    fail('judge', `judge failed: ${(e as Error).message}`);
  }
  return { failures, transcript, judge, ownerMessagesToComplete };
}

export async function runScenario(s: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const runs = Math.max(1, opts.runs ?? 1);
  const failures: Failure[] = [];
  const seen = new Set<string>();
  const judged: JudgeSummary[] = [];
  let passedRuns = 0;
  let transcript: TranscriptTurn[] = [];
  let worstCompletion = -1;
  for (let r = 1; r <= runs; r++) {
    const res = await oneRun(s, opts, r);
    transcript = res.transcript;
    worstCompletion = Math.max(worstCompletion, res.ownerMessagesToComplete ?? Infinity);
    if (res.judge) judged.push(res.judge);
    if (res.failures.length === 0) passedRuns++;
    for (const f of res.failures) {
      const key = `${f.kind}|${f.turn ?? ''}|${f.detail}`;
      if (!seen.has(key)) { seen.add(key); failures.push(f); }
    }
  }
  const mean = (k: 'warmth' | 'brevity' | 'average') => Math.round((judged.reduce((n, j) => n + j[k], 0) / judged.length) * 100) / 100;
  const judge = judged.length ? { warmth: mean('warmth'), brevity: mean('brevity'), average: mean('average'), notes: judged[judged.length - 1]!.notes } : undefined;
  const ownerMessagesToComplete = Number.isFinite(worstCompletion) ? worstCompletion : undefined;
  return { scenario: s.id, passed: passedRuns === runs, runs, passedRuns, failures, judge, ownerMessagesToComplete, transcript };
}

function median(xs: readonly number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export async function runSuite(scenarios: readonly Scenario[], opts: RunOptions): Promise<SuiteResult> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s, opts));
  const suiteFailures: string[] = [];

  const judged = results.flatMap((r) => (r.judge ? [r.judge.average] : []));
  const judgeAverage = judged.length ? Math.round((judged.reduce((a, b) => a + b, 0) / judged.length) * 100) / 100 : 0;
  const min = opts.minJudgeAverage ?? MIN_JUDGE;
  if (judgeAverage < min) suiteFailures.push(`judge average ${judgeAverage} < ${min}`);

  const budgeted = scenarios.flatMap((s, i) => (s.maxOwnerMessagesToComplete !== undefined ? [results[i]!.ownerMessagesToComplete ?? Infinity] : []));
  const onboardingMedianMessages = budgeted.length ? median(budgeted) : undefined;
  const maxMedian = opts.maxOnboardingMedian ?? MAX_ONBOARDING_MEDIAN;
  if (onboardingMedianMessages !== undefined && !(onboardingMedianMessages < maxMedian)) {
    suiteFailures.push(`onboarding median ${onboardingMedianMessages} owner messages, must be under ${maxMedian}`);
  }

  return {
    passed: results.every((r) => r.passed) && suiteFailures.length === 0,
    results,
    failures: results.flatMap((r) => r.failures),
    suiteFailures,
    judgeAverage,
    onboardingMedianMessages,
  };
}
