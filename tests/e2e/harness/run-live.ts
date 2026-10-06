/**
 * CLI used by .github/workflows/e2e.yml after a dev deploy: runs the Gate against the deployed dev stack.
 * Exit 0 = pass (or not runnable yet and E2E_REQUIRE_LIVE is not set), exit 1 = broken flow or not runnable while
 * E2E_REQUIRE_LIVE=1. Never prints tokens. Never calls anything but the configured dev API base.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runGate } from './gate.ts';
import { createLivePorts, LIVE_NOT_WIRED, loadLiveConfig } from './live.ts';
import { renderSummary } from './report.ts';

export async function runLive(env: Record<string, string | undefined>, out: (s: string) => void = console.log, fetchImpl: typeof fetch = fetch): Promise<number> {
  const requireLive = env.E2E_REQUIRE_LIVE === '1' || env.E2E_REQUIRE_LIVE === 'true';
  const blocked = (why: string[]): number => {
    out(`Gate e2e NOT RUN against dev:\n${why.map((w) => `  - ${w}`).join('\n')}`);
    out(requireLive ? 'E2E_REQUIRE_LIVE is set, so this fails the run.' : 'Not failing the run (E2E_REQUIRE_LIVE is not set). This is a follow-up, not a pass.');
    return requireLive ? 1 : 0;
  };

  const cfg = loadLiveConfig(env);
  if (!cfg.ok) return blocked([...cfg.missing.map((m) => `${m} is not set`), ...cfg.problems]);
  if (LIVE_NOT_WIRED.length) return blocked(['live adapters still not wired to the dev environment:', ...LIVE_NOT_WIRED.map((p) => `  ${p}`)]);

  const report = await runGate(createLivePorts(cfg.config, fetchImpl));
  const summary = renderSummary(report);
  out(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLive(process.env).then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
