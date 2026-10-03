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
}

/**
 * `pnpm exec tsx evals/src/cli.ts [--runs N] [--only id,id] [--min-judge 4]`
 * Defaults to the scripted fake agents and the offline judge, so it is free and deterministic in CI.
 * Returns the process exit code: 0 when every scenario and the judge gate pass.
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

  const suite = await runSuite(scenarios, { adapter: deps.adapter ?? fakeAdapter, judge: deps.judge ?? heuristicJudge, runs, minJudgeAverage });
  for (const f of suite.failures) log(`FAIL ${f.scenario}${f.turn ? ` turn ${f.turn}` : ''} [${f.kind}] ${f.detail}`);
  const ok = suite.results.filter((r) => r.passed).length;
  log(`evals: ${ok}/${suite.results.length} scenarios passed (${runs} run${runs === 1 ? '' : 's'} each), judge average ${suite.judgeAverage} (gate ${minJudgeAverage})`);
  return { code: suite.passed ? 0 : 1, suite };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(({ code }) => process.exit(code));
}
