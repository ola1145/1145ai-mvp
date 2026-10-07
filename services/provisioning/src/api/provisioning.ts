/**
 * Onboarding API: start provisioning (execution name = onboardingId) and read status.
 * Owner: issue D1 (tasks/D1.md). Contract: contracts/openapi/onboarding-internal.yaml.
 *
 * The agent asks, the workflow does. POST starts the Step Functions run and returns; it never waits and never buys
 * anything itself. GET reads the run back as plain-language progress for the chat and the dashboard.
 *
 * Money and identity guards, all deterministic and none of them the model's call:
 *  - 409 identity_not_confirmed until the owner's sign-in is confirmed (web chat is signed in already; Telegram needs
 *    the reverse confirmation, D4).
 *  - The tenant id is generated here, once, and stored on the onboarding. A body can't supply it, and a repeat call or a
 *    restart reuses it, so the ORDER# record (D5) keeps protecting the purchase across attempts.
 *  - The execution name is the onboarding id, so a repeat call returns the run that exists. After a run FAILED, the
 *    next call starts attempt 2 as `<onboardingId>.2` (up to 3): Step Functions never reuses a closed run's name.
 */
import { randomBytes } from 'node:crypto';
import { DescribeExecutionCommand, GetExecutionHistoryCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  AREA_CODE_RE, authorize, fail, json, lazyHandler, methodOf, prodCoreDeps, readJsonBody, required,
  type ApiEvent, type ApiResult, type AreaHint, type CoreDeps, type OnboardingState,
} from './basics.js';

// ---------------------------------------------------------------------------------------------------------------
// Step Functions, behind a small interface so tests never need AWS
// ---------------------------------------------------------------------------------------------------------------

export type ExecutionStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED' | 'PENDING_REDRIVE';

export interface ExecutionInfo { executionArn: string; status: ExecutionStatus; output?: string; startDate?: Date }

/** The parts of a Step Functions history event this file reads. The AWS SDK's HistoryEvent is assignable to it. */
export interface HistoryEvent {
  id: number;
  previousEventId?: number;
  type: string;
  stateEnteredEventDetails?: { name?: string; input?: string };
  stateExitedEventDetails?: { name?: string; output?: string };
  [details: `${string}EventDetails`]: { name?: string; input?: string; output?: string; error?: string; cause?: string } | undefined;
}

export interface Workflow {
  /** Starts the execution called `name`. `existed` is true when that name was already taken and its run is returned instead. */
  start(name: string, input: Record<string, unknown>): Promise<{ executionArn: string; existed: boolean }>;
  describe(name: string): Promise<ExecutionInfo | undefined>;
  history(name: string): Promise<HistoryEvent[]>;
}

const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_PAGES = 5;
const errName = (err: unknown) => (err as { name?: string })?.name;

export function sfnWorkflow(client: { send(command: any): Promise<any> }, stateMachineArn: string): Workflow {
  const executionArn = (name: string) => `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
  return {
    async start(name, input) {
      try {
        const r = await client.send(new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }));
        return { executionArn: String(r.executionArn), existed: false };
      } catch (err) {
        // Same name with a different input, or a run that already closed: the name is taken. That run is the answer.
        if (errName(err) === 'ExecutionAlreadyExists') return { executionArn: executionArn(name), existed: true };
        throw err;
      }
    },

    async describe(name) {
      try {
        const r = await client.send(new DescribeExecutionCommand({ executionArn: executionArn(name) }));
        return {
          executionArn: String(r.executionArn ?? executionArn(name)), status: r.status as ExecutionStatus,
          ...(typeof r.output === 'string' ? { output: r.output } : {}),
          ...(r.startDate ? { startDate: r.startDate as Date } : {}),
        };
      } catch (err) {
        if (errName(err) === 'ExecutionDoesNotExist') return undefined;
        throw err;
      }
    },

    async history(name) {
      const events: HistoryEvent[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
        const r = await client.send(new GetExecutionHistoryCommand({
          executionArn: executionArn(name), maxResults: HISTORY_PAGE_SIZE, includeExecutionData: true, ...(nextToken ? { nextToken } : {}),
        }));
        events.push(...((r.events ?? []) as HistoryEvent[]));
        nextToken = r.nextToken;
        if (!nextToken) break;
      }
      return events;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a run: branch states -> plain-language progress
// ---------------------------------------------------------------------------------------------------------------

type StepName = 'payment' | 'number' | 'knowledge' | 'profile' | 'agent_name' | 'smoke_call' | 'activate';
type StepState = 'pending' | 'started' | 'waiting_owner' | 'done' | 'failed' | 'stopped';
type WaitingOn = 'card' | 'facts' | 'hours_and_services' | 'agent_name';
type Overall = 'not_started' | 'running' | 'waiting_on_owner' | 'needs_card' | 'done' | 'failed' | 'waitlisted';

export interface StepStatus { step: StepName; state: StepState; messageForOwner?: string }

export interface ProgressSummary {
  state: Overall;
  steps: StepStatus[];
  /** The `messageForOwner` of every step that has begun, in order. This is what the agent can say in its own words. */
  progress: string[];
  waitingOn: WaitingOn[];
  testCall: 'pending' | 'queued' | 'done' | 'failed';
  number?: string;
  numberDisplay?: string;
}

/** State names of the workflow in infra/cdk/lib/provisioning-stack.ts, grouped the way the owner thinks of them. */
const STEPS: Array<{ step: StepName; states: string[] }> = [
  { step: 'payment', states: ['CheckPaymentMethod'] },
  { step: 'number', states: ['SearchNumber', 'OrderNumber', 'BindEngine'] },
  { step: 'knowledge', states: ['ScrapeKnowledge', 'AwaitFactsConfirmed'] },
  { step: 'profile', states: ['AwaitProfileComplete'] },
  { step: 'agent_name', states: ['RenderAgent', 'AwaitAgentName'] },
  { step: 'smoke_call', states: ['SmokeCall'] },
  { step: 'activate', states: ['ActivateTenant'] },
];
/** waitForTaskToken states: the run is parked until the owner answers. */
const OWNER_STATES = new Set(['AwaitFactsConfirmed', 'AwaitProfileComplete', 'AwaitAgentName']);
const WAITING_ON: Partial<Record<StepName, WaitingOn>> = { payment: 'card', knowledge: 'facts', profile: 'hours_and_services', agent_name: 'agent_name' };

type Line = { messageForOwner: string };

/**
 * Chat copy: the agent reads these and passes them on in its own voice, so they follow 1145-conversation-style
 * (short, plain, contractions, no raw error names). CI checks every `messageForOwner` literal below.
 */
const COPY: Record<StepName, { active: Record<string, Line>; done: Line; failed: Line; special?: Line }> = {
  payment: {
    active: { CheckPaymentMethod: { messageForOwner: 'Checking for a card on file.' } },
    done: { messageForOwner: 'Your card is on file.' },
    failed: { messageForOwner: "I couldn't check for a card just now." },
    special: { messageForOwner: 'I need a card on file before I can get your number.' },
  },
  number: {
    active: {
      SearchNumber: { messageForOwner: 'Looking for a local number near you.' },
      OrderNumber: { messageForOwner: 'Grabbing your number now.' },
      BindEngine: { messageForOwner: 'Hooking your number up to the receptionist.' },
    },
    done: { messageForOwner: 'Your new number is ready.' },
    failed: { messageForOwner: 'Something went wrong getting your number.' },
    special: { messageForOwner: "I couldn't find a number near you this time." },
  },
  knowledge: {
    active: {
      ScrapeKnowledge: { messageForOwner: 'Reading your website now.' },
      AwaitFactsConfirmed: { messageForOwner: 'A few things from your website are waiting on your OK.' },
    },
    done: { messageForOwner: 'Your website details are confirmed.' },
    failed: { messageForOwner: "I couldn't read your website this time." },
  },
  profile: {
    active: { AwaitProfileComplete: { messageForOwner: 'Waiting on your hours and services.' } },
    done: { messageForOwner: 'Your hours and services are in.' },
    failed: { messageForOwner: 'Something went wrong with your hours and services.' },
  },
  agent_name: {
    active: {
      RenderAgent: { messageForOwner: "Writing your receptionist's instructions." },
      AwaitAgentName: { messageForOwner: 'Waiting on a name for your receptionist.' },
    },
    done: { messageForOwner: 'Your receptionist has a name.' },
    failed: { messageForOwner: 'Something went wrong setting up your receptionist.' },
  },
  smoke_call: {
    active: { SmokeCall: { messageForOwner: 'Calling your phone for a quick test.' } },
    done: { messageForOwner: 'The test call went through.' },
    failed: { messageForOwner: "The test call didn't connect." },
  },
  activate: {
    active: { ActivateTenant: { messageForOwner: 'Switching your receptionist on.' } },
    done: { messageForOwner: 'Your receptionist is live.' },
    failed: { messageForOwner: "I couldn't switch your receptionist on yet." },
  },
};
const STOPPED: Line = { messageForOwner: 'Paused for now.' };
/** Used when the run can't be read in detail (history unavailable, or no step has begun yet). */
const OVERALL_LINE: Partial<Record<Overall, Line>> = {
  running: { messageForOwner: 'Setup is running. Give it a minute.' },
  done: { messageForOwner: 'Setup is finished.' },
  failed: { messageForOwner: 'Setup ran into a problem.' },
};

interface Seen { entered: boolean; exited: boolean; exitOutput?: string; failure?: string }

const FAILURE_EVENT = /(?:Failed|TimedOut)$/;

function errorOf(e: HistoryEvent): string {
  for (const [k, v] of Object.entries(e)) {
    if (k.endsWith('EventDetails') && v && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string') return (v as { error: string }).error;
  }
  return 'Unknown';
}

function scan(events: readonly HistoryEvent[]) {
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const seen = new Map<string, Seen>();
  const entry = (name: string) => { let s = seen.get(name); if (!s) { s = { entered: false, exited: false }; seen.set(name, s); } return s; };
  /** A failure event doesn't name its state; follow previousEventId back to the state it belongs to (retries stay in the chain). */
  const owningState = (e: HistoryEvent): string | undefined => {
    let cur: HistoryEvent | undefined = e;
    for (let hops = 0; cur && hops < 200; hops++) {
      const name = cur.stateEnteredEventDetails?.name;
      if (name) return name;
      cur = cur.previousEventId === undefined ? undefined : byId.get(cur.previousEventId);
    }
    return undefined;
  };
  let caught = false; // the Parallel's catch routed to NotifyFailure: the run "succeeds" but it did not go well
  for (const e of events) {
    const entered = e.stateEnteredEventDetails?.name;
    if (entered) { entry(entered).entered = true; if (entered === 'NotifyFailure') caught = true; }
    const exited = e.stateExitedEventDetails;
    if (exited?.name) { const s = entry(exited.name); s.exited = true; if (exited.output) s.exitOutput = exited.output; }
    if (FAILURE_EVENT.test(e.type) && !e.type.startsWith('Execution')) {
      const owner = owningState(e);
      if (owner) entry(owner).failure = errorOf(e);
    }
  }
  return { seen, caught };
}

const parseJson = (s: string | undefined): Record<string, any> | undefined => {
  if (!s) return undefined;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : undefined; } catch { return undefined; }
};
const outputHasError = (output: string | undefined) => Boolean(parseJson(output)?.error);
const boundNumber = (output: string | undefined): string | undefined => {
  const n = parseJson(output)?.number?.binding?.number;
  return typeof n === 'string' && /^\+\d{8,15}$/.test(n) ? n : undefined;
};

export function displayNumber(e164: string): string {
  const m = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

type Outcome = 'running' | 'done' | 'failed';
function outcomeOf(ex: ExecutionInfo): Outcome {
  if (ex.status === 'RUNNING' || ex.status === 'PENDING_REDRIVE') return 'running';
  if (ex.status === 'SUCCEEDED') return outputHasError(ex.output) ? 'failed' : 'done';
  return 'failed';
}

/**
 * Merges what each branch has done into one list the agent can speak from. `history` is undefined when it could not be
 * read: then only the execution's own status is used, which is coarser but never wrong.
 */
export function summarize(ex: ExecutionInfo, history: readonly HistoryEvent[] | undefined): ProgressSummary {
  const outcome = outcomeOf(ex);
  const { seen, caught } = scan(history ?? []);
  const closedFailure = outcome === 'failed' || caught;
  const inFlight = (name: string) => { const s = seen.get(name); return Boolean(s?.entered && !s.exited); };

  // When a run fails, the branch that broke is "failed"; the others were only parked and are "stopped". If the history
  // does not say which one broke (whole-run timeout, abort), whatever was in flight did not finish.
  const failed = new Set<string>();
  const stopped = new Set<string>();
  if (closedFailure) {
    const flying = STEPS.flatMap((s) => s.states).filter(inFlight);
    const broke = flying.filter((n) => seen.get(n)?.failure);
    for (const n of flying) (broke.length === 0 || broke.includes(n) ? failed : stopped).add(n);
  }

  const steps: StepStatus[] = [];
  for (const def of STEPS) {
    const copy = COPY[def.step];
    const last = def.states[def.states.length - 1]!;
    let state: StepState = 'pending';
    let line: Line | undefined;
    const failedAt = def.states.find((n) => failed.has(n));
    const stoppedAt = def.states.find((n) => stopped.has(n));

    if (seen.get(last)?.exited) { state = 'done'; line = copy.done; }
    else if (failedAt) {
      const error = seen.get(failedAt)?.failure;
      if (def.step === 'payment' && error === 'NeedsPaymentMethod') { state = 'waiting_owner'; line = copy.special; }
      else { state = 'failed'; line = def.step === 'number' && error === 'NoNumberAvailable' ? copy.special : copy.failed; }
    } else if (stoppedAt) { state = 'stopped'; line = STOPPED; }
    else {
      const active = [...def.states].reverse().find(inFlight);
      const lastExited = def.states.map((n, i) => (seen.get(n)?.exited ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      const current = active ?? (lastExited >= 0 ? def.states[lastExited + 1] : undefined); // between two of its states
      if (current) {
        state = OWNER_STATES.has(current) ? 'waiting_owner' : 'started';
        line = copy.active[current] ?? Object.values(copy.active)[0];
      }
    }
    // The card check only speaks up when it has something to say.
    if (def.step === 'payment' && (state === 'pending' || state === 'done')) continue;
    steps.push({ step: def.step, state, ...(line ? { messageForOwner: line.messageForOwner } : {}) });
  }

  const stateOf = (step: StepName) => steps.find((s) => s.step === step)?.state ?? 'pending';
  const waitingOn = steps.filter((s) => s.state === 'waiting_owner').map((s) => WAITING_ON[s.step]).filter((w): w is WaitingOn => Boolean(w));

  const smoke = stateOf('smoke_call');
  const testCall: ProgressSummary['testCall'] = smoke === 'done' ? 'done' : smoke === 'failed' ? 'failed' : smoke === 'started' || smoke === 'waiting_owner' ? 'queued' : 'pending';

  let overall: Overall;
  if (closedFailure) overall = waitingOn.includes('card') ? 'needs_card' : 'failed';
  else if (stateOf('activate') === 'done' || outcome === 'done') overall = 'done';
  else if (steps.some((s) => s.state === 'started')) overall = 'running';
  else if (waitingOn.length > 0) overall = 'waiting_on_owner';
  else overall = 'running';

  // Never hand out a number that is not live: after a bind, or from the finished run's own output.
  const number = history && history.length > 0
    ? (stateOf('number') === 'done' ? boundNumber(seen.get('BindEngine')?.exitOutput) ?? boundNumber(ex.output) : undefined)
    : outcome === 'done' ? boundNumber(ex.output) : undefined;

  let progress = steps.filter((s) => s.messageForOwner && s.state !== 'pending' && s.state !== 'stopped').map((s) => s.messageForOwner!);
  if (progress.length === 0) {
    const line = OVERALL_LINE[overall === 'needs_card' ? 'failed' : overall === 'waiting_on_owner' ? 'running' : overall];
    if (line) progress = [line.messageForOwner];
  }

  return { state: overall, steps, progress, waitingOn, testCall, ...(number ? { number, numberDisplay: displayNumber(number) } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------------------------

export interface ProvisioningDeps extends CoreDeps {
  workflow: Workflow;
  newTenantId?: () => string;
}

const MAX_ATTEMPTS = 3;
/** t_ + 20 hex characters: matches `asTenantId`, unguessable, lowercase. Generated server-side only. */
const defaultTenantId = () => `t_${randomBytes(10).toString('hex')}`;

/**
 * Web chat owners are signed in with Cognito before their first message, so they are confirmed. Everyone else (Telegram)
 * is confirmed only after the reverse-confirmation YES; D4's callback sets `identityStatus: 'confirmed'`.
 */
function identityConfirmed(state: OnboardingState): boolean {
  if (state.identityStatus === 'pending' || state.identityStatus === 'rejected') return false;
  return state.identityStatus === 'confirmed' || state.channel === 'webchat';
}

const cleanAreaCode = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const digits = v.trim().replace(/^\((\d{3})\)$/, '$1');
  return AREA_CODE_RE.test(digits) ? digits : undefined;
};

const executionName = (onboardingId: string, attempt: number) => (attempt <= 1 ? onboardingId : `${onboardingId}.${attempt}`);

export function makeHandler(deps: ProvisioningDeps) {
  const newTenantId = deps.newTenantId ?? defaultTenantId;
  const now = () => deps.now?.() ?? new Date();

  async function start(id: string, ev: ApiEvent): Promise<ApiResult> {
    const parsed = readJsonBody(ev);
    if (!parsed.ok) return parsed.response;

    const state = await deps.store.getState(id);
    if (!state) return fail(404, 'unknown_onboarding', 'No such onboarding.');
    if (state.waitlisted || state.status === 'waitlisted') return fail(409, 'waitlisted', 'This business is on the waitlist, so setup does not start.');
    if (!identityConfirmed(state)) return fail(409, 'identity_not_confirmed', 'Sign-in is not confirmed yet.');

    // A run already exists: return it. Only a run that failed is started again, under the next attempt name.
    let attempt = 1;
    const prior = state.provisioning;
    if (prior) {
      let existing: ExecutionInfo | undefined;
      try {
        existing = await deps.workflow.describe(prior.executionName);
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', msg: 'describe execution failed', onboardingId: id, err: String(err) }));
        return fail(503, 'unavailable', 'Could not check on setup just now.');
      }
      if (existing) {
        const outcome = outcomeOf(existing);
        if (outcome !== 'failed') return json(200, { state: outcome === 'done' ? 'done' : 'running', alreadyStarted: true, attempt: prior.attempt });
        if (prior.attempt >= MAX_ATTEMPTS) return fail(409, 'provisioning_failed', 'Setup has failed several times.');
        attempt = prior.attempt + 1;
      } else {
        attempt = prior.attempt; // the run has aged out of Step Functions: its name is free again
      }
    }

    const basics = await deps.store.getBasics(id);
    if (!basics) return fail(409, 'basics_missing', 'The business basics are not saved yet.');
    const areaCode = cleanAreaCode(parsed.body.preferredAreaCode) ?? basics.area?.areaCode;
    const area: AreaHint = { ...(areaCode ? { areaCode } : {}), ...(basics.area?.state ? { state: basics.area.state } : {}) };
    if (!area.areaCode && !area.state) return fail(422, 'area_needed', 'No state or area code to search for a number.');

    const tenantId = await deps.store.ensureTenantId(id, newTenantId());
    const name = executionName(id, attempt);
    const input = {
      onboardingId: id,
      tenantId,
      area,
      basics: { businessName: basics.businessName, businessType: basics.businessType, ...(basics.website ? { website: basics.website } : {}) },
    };

    let started: { executionArn: string; existed: boolean };
    try {
      started = await deps.workflow.start(name, input);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'start execution failed', onboardingId: id, err: String(err) }));
      return fail(503, 'unavailable', 'Could not start setup just now.');
    }
    await deps.store.recordProvisioning(id, { executionName: name, attempt, startedAt: now().toISOString() });
    return json(started.existed ? 200 : 202, { state: started.existed ? 'running' : 'started', alreadyStarted: started.existed, attempt });
  }

  async function status(id: string): Promise<ApiResult> {
    const state = await deps.store.getState(id);
    if (!state) return fail(404, 'unknown_onboarding', 'No such onboarding.');
    const idle = (overall: Overall) => json(200, { state: overall, steps: [], progress: [], waitingOn: [], testCall: 'pending' });
    if (state.waitlisted || state.status === 'waitlisted') return idle('waitlisted');

    const prior = state.provisioning;
    if (!prior) return idle('not_started');
    let existing: ExecutionInfo | undefined;
    try {
      existing = await deps.workflow.describe(prior.executionName);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'describe execution failed', onboardingId: id, err: String(err) }));
      return fail(503, 'unavailable', 'Could not check on setup just now.');
    }
    if (!existing) return idle('not_started'); // aged out: do not claim progress we can't see

    let history: HistoryEvent[] | undefined;
    try {
      history = await deps.workflow.history(prior.executionName);
    } catch (err) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'execution history unavailable; using execution status only', onboardingId: id, err: String(err) }));
    }
    return json(200, summarize(existing, history));
  }

  return async function handler(event: unknown): Promise<ApiResult> {
    const ev = (event ?? {}) as ApiEvent;
    try {
      const auth = await authorize(ev, deps);
      if (!auth.ok) return auth.response;
      const method = methodOf(ev);
      if (method === 'POST') return await start(auth.onboardingId, ev);
      if (method === 'GET') return await status(auth.onboardingId);
      return fail(405, 'method_not_allowed', 'Use POST to start or GET to check.');
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'provisioning failed', err: String(err) }));
      return fail(500, 'internal_error', 'Something went wrong on our side.');
    }
  };
}

export const handler = lazyHandler(() => makeHandler({
  ...prodCoreDeps(),
  workflow: sfnWorkflow(new SFNClient({}), required(process.env, 'STATE_MACHINE_ARN')),
}));
