/* Voice-path latency benchmark for the deployed tool API (dev). Not run in CI; see bench/README.md.
 *
 *   BASE_URL=https://<id>.execute-api.<region>.amazonaws.com TOOL_TOKEN=<customer-agent token> \
 *   N=200 CONCURRENCY=4 pnpm tsx services/tool-api/bench/run.ts
 *
 * TOOL_TOKEN is a signed customer-agent token for a seeded dev tenant (see README for how the owner mints one).
 * Measures client-observed latency per route: the first request after a pause is reported separately as "cold-ish",
 * and p50/p95/p99 are computed over the remaining requests. Prints a markdown table to paste into README.md.
 */

import { percentile } from './stats.js';

const base = process.env.BASE_URL;
const token = process.env.TOOL_TOKEN;
if (!base || !token) { console.error('Set BASE_URL and TOOL_TOKEN (dev only).'); process.exit(2); }
if (/prod/i.test(base) && process.env.ALLOW_NON_DEV !== '1') { console.error('Refusing to benchmark a URL that looks like prod.'); process.exit(2); }

const N = Math.max(10, Number(process.env.N ?? 200));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 4));
const WARMUP = Math.max(0, Number(process.env.WARMUP ?? 10));

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const scenarios: Array<{ name: string; path: string; body: () => unknown }> = [
  { name: 'availability', path: '/v1/tools/availability', body: () => ({ dateFrom: `${day(1)}T00:00:00Z`, dateTo: `${day(4)}T00:00:00Z` }) },
  { name: 'caller/lookup', path: '/v1/tools/caller/lookup', body: () => ({}) },
  { name: 'kb/search', path: '/v1/tools/kb/search', body: () => ({ query: 'what are your opening hours' }) },
  { name: 'handoff', path: '/v1/tools/handoff', body: () => ({ reason: 'benchmark' }) },
];

async function once(path: string, body: unknown): Promise<{ ms: number; status: number }> {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await res.arrayBuffer();
  return { ms: performance.now() - t, status: res.status };
}

async function run(s: (typeof scenarios)[number]) {
  const first = await once(s.path, s.body());
  for (let i = 0; i < WARMUP; i++) await once(s.path, s.body());
  const samples: number[] = [];
  const statuses = new Map<number, number>();
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next++ < N) {
      const r = await once(s.path, s.body());
      samples.push(r.ms);
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    }
  }));
  samples.sort((a, b) => a - b);
  return { first, samples, statuses };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`| route | n | first | p50 | p95 | p99 | max | statuses |\n|---|---|---|---|---|---|---|---|`);
  for (const s of scenarios) {
    const r = await run(s);
    const f = (n: number) => `${n.toFixed(0)} ms`;
    const st = [...r.statuses].map(([k, v]) => `${k}x${v}`).join(' ');
    console.log(`| ${s.name} | ${r.samples.length} | ${f(r.first.ms)} | ${f(percentile(r.samples, 50))} | ${f(percentile(r.samples, 95))} | ${f(percentile(r.samples, 99))} | ${f(r.samples.at(-1) ?? Number.NaN)} | ${st} |`);
  }
}
