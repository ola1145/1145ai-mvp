// Daily dependency batch for P3: read every contracts/CHANGE_REQUESTS/*.md and print the requested packages,
// grouped, plus any request P3 cannot read. P3 applies the batch in ONE lockfile PR; no other lane edits lockfiles.
// Format a lane writes (see scripts/ci/README.md):
//   Kind: dependency
//   - npm: `zod@^3.23.0` in services/tool-api
//   - uv: `httpx>=0.27` in engines/livekit-agent
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDepRequests, renderDepBatch, unparsedDepRequests } from './lib.js';

const dir = process.argv[2] ?? 'contracts/CHANGE_REQUESTS';
const files = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ path: join(dir, f), text: readFileSync(join(dir, f), 'utf8') }))
  : [];
console.log(renderDepBatch(parseDepRequests(files)));
const bad = unparsedDepRequests(files);
if (bad.length) console.log(`\nCannot read the package lines in: ${bad.join(', ')}. Ask the author to use "- npm: \`name@range\` in <dir>".`);
