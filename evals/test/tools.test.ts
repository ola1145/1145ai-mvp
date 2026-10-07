import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, isKnownTool, toolMatches } from '../src/tools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Names in the list a make_*_tools factory returns: `return [save_hours, ...]` after `def <factory>(`. */
function factoryTools(file: string, factory: string): string[] {
  const src = read(file);
  const body = src.slice(src.indexOf(`def ${factory}(`));
  const m = /\n {4}return \[([^\]]+)\]/.exec(body);
  if (!m) throw new Error(`no return list in ${factory}`);
  return m[1]!.split(',').map((x) => x.trim()).filter(Boolean);
}

describe('tool registry', () => {
  it('matches the tools the agents really give their models, so scenarios test what the agents do', () => {
    expect([...AGENT_TOOLS.onboarding].sort()).toEqual(factoryTools('agents/onboarding/tools.py', 'make_onboarding_tools').sort());
    expect([...AGENT_TOOLS.admin].sort()).toEqual(factoryTools('agents/admin/tools.py', 'make_admin_tools').sort());
    const voice = [...read('engines/livekit-agent/src/frontdesk/agent.py').matchAll(/@function_tool\(\)\s*\n\s*async def (\w+)\(/g)].map((m) => m[1]!);
    expect([...AGENT_TOOLS.customer].sort()).toEqual(voice.sort());
  });

  it('matches exact names and prefix globs', () => {
    expect(toolMatches('propose_*', 'propose_closed_date')).toBe(true);
    expect(toolMatches('propose_*', 'list_bookings')).toBe(false);
    expect(toolMatches('list_bookings', 'list_bookings')).toBe(true);
    expect(toolMatches('list_booking', 'list_bookings')).toBe(false);
    expect(isKnownTool('admin', 'propose_*')).toBe(true);
    expect(isKnownTool('customer', 'propose_*')).toBe(false);
    expect(isKnownTool('customer', 'transfer_to_team')).toBe(true);
  });
});
