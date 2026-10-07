import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StyleChannel } from '../../packages/conversation-style/src/index.js';
import { AGENT_TOOLS, isKnownTool } from './tools.js';
import { parseYaml, type YamlValue } from './yaml.js';

export type AgentKind = 'customer' | 'onboarding' | 'admin';
export type ScenarioChannel = 'voice' | 'webchat' | 'telegram';

export interface Expect {
  /** Each must be called this turn (`propose_*` globs allowed). An explicit empty list means no tool at all. */
  tools_called?: string[];
  tools_not_called?: string[];
  reply_contains?: string[];
  reply_contains_any?: string[];
  reply_not_contains?: string[];
  /** Answer first: the reply's first sentence (or first line) contains one of these. */
  first_sentence_contains_any?: string[];
  reply_max_chars?: number;
  reply_max_words?: number;
  /** The reply asks the person to verify before acting (a question about a code, last name or the number on file). */
  reply_asks_for_verification?: boolean;
  /** No API path the agent's tools hit this turn contains any of these (e.g. another onboarding id). */
  api_paths_not_contains?: string[];
}

export interface FakeTurn {
  reply: string;
  tools: string[];
  /** API paths the reference agent's tools hit this turn. Only needed when the turn checks api_paths_not_contains. */
  apiPaths?: string[];
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
  /**
   * What the agent's tools get back, keyed "<METHOD> <path suffix>" (e.g. "GET /facts", "POST /v1/admin/changes").
   * A live adapter serves these from a fake tool API so the real model sees the same data the `fake` replies assume.
   * Errors look like the real client's: { error: <code>, status: <http status> }. The fake adapter ignores this.
   */
  api: Record<string, YamlValue>;
  /** Onboarding only: setup must finish (name_agent and provisioning_status both called) within this many owner messages. */
  maxOwnerMessagesToComplete?: number;
}

const LIST_KEYS = ['tools_called', 'tools_not_called', 'reply_contains', 'reply_contains_any', 'reply_not_contains', 'first_sentence_contains_any', 'api_paths_not_contains'] as const;
const NUMBER_KEYS = ['reply_max_chars', 'reply_max_words'] as const;
const EXPECT_KEYS = new Set<string>([...LIST_KEYS, ...NUMBER_KEYS, 'reply_asks_for_verification']);
const TOP_KEYS = new Set(['agent', 'channel', 'tenant_fixture', 'caller_id', 'referral_code', 'tags', 'greeting', 'turns', 'rules', 'notes', 'api']);
const TURN_KEYS = new Set(['caller', 'owner', 'interrupts', 'expect', 'fake']);
const FAKE_KEYS = new Set(['reply', 'tools', 'api_paths']);
const RULE_KEYS = new Set(['first_utterance_contains', 'max_owner_messages_to_complete']);
const API_KEY = /^(?:GET|POST|PUT|PATCH|DELETE) \/\S*$/;
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

  const tools = (names: string[], where: string): string[] => {
    for (const t of names) {
      if (!isKnownTool(agent, t)) throw new Error(`${where}: "${t}" is not a ${agent} agent tool (${AGENT_TOOLS[agent].join(', ')})`);
    }
    return names;
  };

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
    for (const k of LIST_KEYS) {
      if (expectRaw[k] !== undefined) expect[k] = strList(expectRaw[k], `${at}.${k}`);
    }
    tools([...(expect.tools_called ?? []), ...(expect.tools_not_called ?? [])], at);
    for (const k of NUMBER_KEYS) {
      if (expectRaw[k] !== undefined) {
        if (typeof expectRaw[k] !== 'number') throw new Error(`${at}: ${k} must be a number`);
        expect[k] = expectRaw[k] as number;
      }
    }
    if (expectRaw.reply_asks_for_verification !== undefined) expect.reply_asks_for_verification = expectRaw.reply_asks_for_verification === true;

    let fake: FakeTurn | undefined;
    if (raw.fake !== undefined) {
      if (!isObj(raw.fake) || typeof raw.fake.reply !== 'string') throw new Error(`${at}: fake needs a reply string`);
      for (const k of Object.keys(raw.fake)) if (!FAKE_KEYS.has(k)) throw new Error(`${at}: unknown fake key "${k}"`);
      const fakeTools = tools(strList(raw.fake.tools, `${at}.fake.tools`), `${at}.fake`);
      if (fakeTools.some((t) => t.includes('*'))) throw new Error(`${at}: fake.tools must name real calls, not globs`);
      fake = { reply: raw.fake.reply, tools: fakeTools };
      if (raw.fake.api_paths !== undefined) fake.apiPaths = strList(raw.fake.api_paths, `${at}.fake.api_paths`);
    }
    return { speaker, text: raw[speaker] as string, interrupts: raw.interrupts === true, expect, fake };
  });

  const rules = doc.rules ?? {};
  if (!isObj(rules)) throw new Error(w('rules must be a map'));
  for (const k of Object.keys(rules)) if (!RULE_KEYS.has(k)) throw new Error(w(`unknown rule "${k}"`));
  const budget = rules.max_owner_messages_to_complete;
  if (budget !== undefined) {
    if (agent !== 'onboarding') throw new Error(w('max_owner_messages_to_complete only applies to onboarding scenarios'));
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1) throw new Error(w('max_owner_messages_to_complete must be a positive whole number'));
  }

  const api = doc.api ?? {};
  if (!isObj(api)) throw new Error(w('api must be a map of "<METHOD> <path>" to the response the tool gets'));
  for (const k of Object.keys(api)) if (!API_KEY.test(k)) throw new Error(w(`bad api key "${k}", expected "<METHOD> /path"`));

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
    api,
    maxOwnerMessagesToComplete: budget as number | undefined,
  };
}

export const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

export function loadScenarios(dir: string = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parseScenario(basename(f, '.yaml'), readFileSync(join(dir, f), 'utf8')));
}
