import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkConversation, checkReply } from '../../packages/conversation-style/src/index.js';
import { fromPython, fromTypeScript, type CopyLine } from './extract-copy.js';

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === 'test' || e === 'tests') continue;
    if (statSync(p).isDirectory()) walk(p, ext, acc); else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}

const lines: CopyLine[] = [
  ...walk('services', '.ts').flatMap((f) => fromTypeScript(f, readFileSync(f, 'utf8'))),
  ...walk('engines/livekit-agent/src', '.py').filter((f) => !f.endsWith('prompts.py')).flatMap((f) => fromPython(f, readFileSync(f, 'utf8'))),
];

let errors = 0; let warns = 0;
for (const l of lines) {
  for (const i of checkReply(l.text, { channel: l.channel })) {
    console.log(`${i.severity.toUpperCase()} ${l.file}: ${i.rule} ${i.detail} — "${l.text}"`);
    i.severity === 'error' ? errors++ : warns++;
  }
}
for (const f of walk('evals/goldens', '.json')) {
  const g = JSON.parse(readFileSync(f, 'utf8')) as { channel: 'voice' | 'chat'; personName?: string; turns: Array<{ role: 'agent' | 'user'; text: string }> };
  for (const t of checkConversation(g.turns, g.channel, g.personName)) {
    for (const i of t.issues) { console.log(`${i.severity.toUpperCase()} ${f} turn ${t.turn}: ${i.rule} ${i.detail}`); i.severity === 'error' ? errors++ : warns++; }
    if (t.score < 85) { console.log(`ERROR ${f} turn ${t.turn}: naturalness ${t.score} < 85`); errors++; }
  }
}
console.log(`conversation-style: ${lines.length} copy lines checked, ${errors} error(s), ${warns} warning(s)`);
process.exit(errors ? 1 : 0);
