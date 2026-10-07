import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeAdapter, type AgentAdapter } from './adapters.js';
import { heuristicJudge, type Judge } from './judge.js';
import { runSuite, type SuiteResult } from './runner.js';
import { loadScenarios, SCENARIO_DIR } from './scenarios.js';

export interface CliDeps {
  adapter?: AgentAdapter;
  judge?: Judge;
  dir?: string;
  log?: (line: string) => void;
  /** Defaults to process.env. Tests pass their own so a developer's shell can't switch them to live. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * What EVALS_LIVE_MODULE must export. The nightly job's module builds an adapter that drives the real agents (LiveKit
 * text session, AgentCore) against a fake tool API serving each scenario's `api` fixture, and an `LlmJudge` on
 * Bedrock. Credentials and paid calls live in that module and that job, never in PR CI.
 */
export interface LiveModule { createLive(): Promise<{ adapter: AgentAdapter; judge?: Judge }> }

type Setup = { adapter: AgentAdapter; judge: Judge; mode: string } | { error: string };

async function setUp(deps: CliDeps, env: Readonly<Record<string, string | undefined>>): Promise<Setup> {
  const modulePath = env.EVALS_LIVE_MODULE;
  if (env.EVALS_LIVE !== '1') {
    const note = modulePath ? ' (EVALS_LIVE_MODULE is ignored without EVALS_LIVE=1)' : '';
    return { adapter: deps.adapter ?? fakeAdapter, judge: deps.judge ?? heuristicJudge, mode: `offline: scripted fakes, heuristic judge, no model calls${note}` };
  }
  // Live was asked for. Never fall back to the fakes: a "live" run that quietly replays scripts is a false green.
  if (!modulePath) return { error: 'EVALS_LIVE=1 needs EVALS_LIVE_MODULE, a module exporting createLive()' };
  let mod: Partial<LiveModule>;
  try {
    mod = (await import(pathToFileURL(isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath)).href)) as Partial<LiveModule>;
  } catch (e) {
    return { error: `could not load EVALS_LIVE_MODULE ${modulePath}: ${(e as Error).message}` };
  }
  if (typeof mod.createLive !== 'function') return { error: `EVALS_LIVE_MODULE ${modulePath} does not export createLive()` };
  const live = await mod.createLive();
  return { adapter: live.adapter, judge: live.judge ?? heuristicJudge, mode: `live: ${modulePath}${live.judge ? '' : ', heuristic judge'} (makes paid model calls)` };
}

/**
 * `pnpm exec tsx evals/src/cli.ts [--runs N] [--only id,id] [--min-judge 4]`
 * Offline by default: the scripted fake agents and the heuristic judge, so it is free and deterministic in CI.
 * `EVALS_LIVE=1 EVALS_LIVE_MODULE=path/to/live.ts` opts in to a live run (nightly job only).
 * Returns the process exit code: 0 when every scenario and the suite gates pass, 1 on a failure, 2 on bad usage.
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<{ code: number; suite?: SuiteResult }> {
  const log = deps.log ?? console.log;
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runs = Number(arg('--runs') ?? 1);
  const minJudgeAverage = Number(arg('--min-judge') ?? 4);
  if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(minJudgeAverage)) {
    log('evals: --runs must be a positive integer and --min-judge a number');
    return { code: 2 };
  }
  const only = arg('--only')?.split(',').filter(Boolean);
  let scenarios = loadScenarios(deps.dir ?? SCENARIO_DIR);
  if (only) {
    const missing = only.filter((id) => !scenarios.some((s) => s.id === id));
    if (missing.length) { log(`evals: unknown scenario(s): ${missing.join(', ')}`); return { code: 2 }; }
    scenarios = scenarios.filter((s) => only.includes(s.id));
  }

  const setup = await setUp(deps, deps.env ?? process.env);
  if ('error' in setup) { log(`evals: ${setup.error}`); return { code: 2 }; }
  log(`evals: ${setup.mode}`);

  const suite = await runSuite(scenarios, { adapter: setup.adapter, judge: setup.judge, runs, minJudgeAverage });
  for (const f of suite.failures) log(`FAIL ${f.scenario}${f.turn ? ` turn ${f.turn}` : ''} [${f.kind}] ${f.detail}`);
  for (const f of suite.suiteFailures) log(`FAIL suite: ${f}`);
  const ok = suite.results.filter((r) => r.passed).length;
  const median = suite.onboardingMedianMessages === undefined ? 'n/a' : `${suite.onboardingMedianMessages} owner messages`;
  log(`evals: ${ok}/${suite.results.length} scenarios passed (${runs} run${runs === 1 ? '' : 's'} each), judge average ${suite.judgeAverage} (gate ${minJudgeAverage}), onboarding median ${median} (gate < 12)`);
  return { code: suite.passed ? 0 : 1, suite };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(({ code }) => process.exit(code));
}
