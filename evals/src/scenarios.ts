import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StyleChannel } from '../../packages/conversation-style/src/index.js';
import { parseYaml, type YamlValue } from './yaml.js';

export type AgentKind = 'customer' | 'onboarding' | 'admin';
export type ScenarioChannel = 'voice' | 'webchat' | 'telegram';

export interface Expect {
  tools_called?: string[];
  tools_not_called?: string[];
  reply_contains?: string[];
  reply_contains_any?: string[];
  reply_not_contains?: string[];
  reply_max_chars?: number;
  reply_max_words?: number;
  /** The reply asks the person to verify before acting (a question about a code, last name or the number on file). */
  reply_asks_for_verification?: boolean;
}

export interface FakeTurn {
  reply: string;
  tools: string[];
}

export interface ScenarioTurn {
  speaker: 'caller' | 'owner';
  text: string;
  /** Voice: the person talks over the agent. The agent's reply should be short and yield. */
  interrupts: boolean;
  expect: Expect;
  /** Scripted reference reply used by the fake adapter. Real adapters ignore it. */
  fake?: FakeTurn;
}

export interface Scenario {
  id: string;
  agent: AgentKind;
  channel: ScenarioChannel;
  styleChannel: StyleChannel;
  tenantFixture?: string;
  callerId?: string;
  referralCode?: string;
  tags: string[];
  /** The agent's opening line. Scripted for the fake adapter; checked like any other agent turn. */
  greeting?: string;
  turns: ScenarioTurn[];
  firstUtteranceContains: string[];
}

const EXPECT_KEYS = new Set<string>([
  'tools_called', 'tools_not_called', 'reply_contains', 'reply_contains_any', 'reply_not_contains',
  'reply_max_chars', 'reply_max_words', 'reply_asks_for_verification',
]);
const TOP_KEYS = new Set(['agent', 'channel', 'tenant_fixture', 'caller_id', 'referral_code', 'tags', 'greeting', 'turns', 'rules', 'notes']);
const TURN_KEYS = new Set(['caller', 'owner', 'interrupts', 'expect', 'fake']);
const AGENTS: AgentKind[] = ['customer', 'onboarding', 'admin'];
const CHANNELS: ScenarioChannel[] = ['voice', 'webchat', 'telegram'];

type Obj = { [k: string]: YamlValue };
const isObj = (v: YamlValue | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: YamlValue | undefined, where: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${where}: expected a list of strings`);
  return v as string[];
};

export function parseScenario(id: string, src: string): Scenario {
  const doc = parseYaml(src);
  const w = (m: string) => `scenario ${id}: ${m}`;
  if (!isObj(doc)) throw new Error(w('top level must be a map'));
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) throw new Error(w(`unknown key "${k}"`));

  const agent = doc.agent as AgentKind;
  if (!AGENTS.includes(agent)) throw new Error(w(`agent must be one of ${AGENTS.join(', ')}`));
  const channel = doc.channel as ScenarioChannel;
  if (!CHANNELS.includes(channel)) throw new Error(w(`channel must be one of ${CHANNELS.join(', ')}`));
  if (!Array.isArray(doc.turns) || doc.turns.length === 0) throw new Error(w('turns must be a non-empty list'));

  const turns = doc.turns.map((raw, i): ScenarioTurn => {
    const at = w(`turn ${i + 1}`);
    if (!isObj(raw)) throw new Error(`${at}: must be a map`);
    for (const k of Object.keys(raw)) if (!TURN_KEYS.has(k)) throw new Error(`${at}: unknown key "${k}"`);
    const speaker = typeof raw.caller === 'string' ? 'caller' : typeof raw.owner === 'string' ? 'owner' : null;
    if (!speaker) throw new Error(`${at}: needs a "caller" or "owner" line`);

    const expectRaw = raw.expect ?? {};
    if (!isObj(expectRaw)) throw new Error(`${at}: expect must be a map`);
    for (const k of Object.keys(expectRaw)) if (!EXPECT_KEYS.has(k)) throw new Error(`${at}: unknown expect key "${k}"`);
    const expect: Expect = {};
    for (const k of ['tools_called', 'tools_not_called', 'reply_contains', 'reply_contains_any', 'reply_not_contains'] as const) {
      if (expectRaw[k] !== undefined) expect[k] = strList(expectRaw[k], `${at}.${k}`);
    }
    for (const k of ['reply_max_chars', 'reply_max_words'] as const) {
      if (expectRaw[k] !== undefined) {
        if (typeof expectRaw[k] !== 'number') throw new Error(`${at}: ${k} must be a number`);
        expect[k] = expectRaw[k] as number;
      }
    }
    if (expectRaw.reply_asks_for_verification !== undefined) expect.reply_asks_for_verification = expectRaw.reply_asks_for_verification === true;

    let fake: FakeTurn | undefined;
    if (raw.fake !== undefined) {
      if (!isObj(raw.fake) || typeof raw.fake.reply !== 'string') throw new Error(`${at}: fake needs a reply string`);
      fake = { reply: raw.fake.reply, tools: strList(raw.fake.tools, `${at}.fake.tools`) };
    }
    return { speaker, text: raw[speaker] as string, interrupts: raw.interrupts === true, expect, fake };
  });

  const rules = doc.rules ?? {};
  if (!isObj(rules)) throw new Error(w('rules must be a map'));
  for (const k of Object.keys(rules)) if (k !== 'first_utterance_contains') throw new Error(w(`unknown rule "${k}"`));

  return {
    id,
    agent,
    channel,
    styleChannel: channel === 'voice' ? 'voice' : 'chat',
    tenantFixture: typeof doc.tenant_fixture === 'string' ? doc.tenant_fixture : undefined,
    callerId: typeof doc.caller_id === 'string' ? doc.caller_id : undefined,
    referralCode: typeof doc.referral_code === 'string' ? doc.referral_code : undefined,
    tags: strList(doc.tags, w('tags')),
    greeting: typeof doc.greeting === 'string' ? doc.greeting : undefined,
    turns,
    firstUtteranceContains: strList(rules.first_utterance_contains, w('first_utterance_contains')),
  };
}

export const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

export function loadScenarios(dir: string = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parseScenario(basename(f, '.yaml'), readFileSync(join(dir, f), 'utf8')));
}
