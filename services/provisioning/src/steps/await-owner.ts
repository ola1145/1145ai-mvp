import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { assertOnboardingId, awsClients, requireEnv, type DocClient } from './emit-status.js';

/**
 * Step: await-owner
 * The waitForTaskToken step behind AwaitFactsConfirmed, AwaitProfileComplete and AwaitAgentName. Step Functions hands
 * this Lambda a task token and then waits, for up to three days, until somebody completes it. This step does one
 * thing: it keeps the token where the onboarding API can find it.
 *
 *   ONBOARDING#<onboardingId> / TASK#<facts|profile|agentName>
 *     taskToken   the live token (a retried state gets a new one; the newest wins)
 *     status      'waiting' until the owner has answered, then 'done'
 *     result      what the owner decided (optional; becomes the state's output)
 *
 * The onboarding API (facts decisions, agent name, profile confirmation) reads that item, calls SendTaskSuccess with
 * the token and marks it done. If the owner answers BEFORE the workflow reaches the wait (they named the agent while
 * the number was still being bought), the API has no token to use, so it records `status: 'done'` and `result`
 * instead, and this step completes the wait itself the moment it arrives. Either way nobody waits three days for an
 * answer that was already given.
 *
 * The token is a bearer secret for the workflow: it is stored, never logged, never returned and never put in an event.
 */

export const OWNER_TASKS = ['facts', 'profile', 'agentName'] as const;
export type OwnerTask = (typeof OWNER_TASKS)[number];

/** A day longer than the 3-day task timeout in provisioning-stack.ts, so the row never disappears under a live wait. */
const TASK_TTL_SECONDS = 4 * 24 * 3600;
const TOKEN_MAX_LENGTH = 2048; // Step Functions tokens are well under 1 KB

export interface AwaitOwnerEvent { token?: unknown; onboardingId?: unknown; what?: unknown }
export interface TaskRow { status?: string; result?: Record<string, unknown> }
export interface TaskStore {
  /** Saves this invocation's token as the live one and returns the item as it now stands. Never resets an earlier answer. */
  saveToken(args: { onboardingId: string; what: OwnerTask; token: string; now: Date; ttlSeconds: number }): Promise<TaskRow>;
}
export interface AwaitOwnerDeps {
  tasks: TaskStore;
  /** SendTaskSuccess with the given output. Used only for an answer that arrived before the wait started. */
  completeTask(token: string, output: Record<string, unknown>): Promise<void>;
  now?: () => Date;
}
export interface AwaitOwnerResult { stored: true; completedEarly: boolean }

export function parseAwaitOwnerEvent(e: AwaitOwnerEvent): { token: string; onboardingId: string; what: OwnerTask } {
  const onboardingId = assertOnboardingId(e?.onboardingId);
  const what = (OWNER_TASKS as readonly unknown[]).includes(e?.what) ? (e.what as OwnerTask) : undefined;
  if (!what) throw new Error('await-owner: unknown owner step');
  const token = e.token;
  if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX_LENGTH) throw new Error('await-owner: missing task token');
  return { token, onboardingId, what };
}

export async function awaitOwner(event: AwaitOwnerEvent, deps: AwaitOwnerDeps): Promise<AwaitOwnerResult> {
  const { token, onboardingId, what } = parseAwaitOwnerEvent(event);
  const now = (deps.now ?? (() => new Date()))();
  const row = await deps.tasks.saveToken({ onboardingId, what, token, now, ttlSeconds: TASK_TTL_SECONDS });

  const completedEarly = row.status === 'done';
  console.log(JSON.stringify({ level: 'info', step: 'await-owner', onboardingId, what, completedEarly })); // never the token
  if (completedEarly) await deps.completeTask(token, row.result ?? {});
  return { stored: true, completedEarly };
}

/** One UpdateItem: sets the token and creates the row as 'waiting' only if there is no earlier status. */
export function ddbTaskStore(client: DocClient, table: string): TaskStore {
  return {
    async saveToken({ onboardingId, what, token, now, ttlSeconds }) {
      const iso = now.toISOString();
      const out = await client.send(new UpdateCommand({
        TableName: table,
        Key: { PK: `ONBOARDING#${assertOnboardingId(onboardingId)}`, SK: `TASK#${what}` },
        UpdateExpression: 'SET taskToken = :t, #w = :w, updatedAt = :now, createdAt = if_not_exists(createdAt, :now), #st = if_not_exists(#st, :waiting), #ttl = :ttl',
        ExpressionAttributeNames: { '#w': 'what', '#st': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':t': token, ':w': what, ':now': iso, ':waiting': 'waiting', ':ttl': Math.floor(now.getTime() / 1000) + ttlSeconds },
        ReturnValues: 'ALL_NEW',
      }));
      const a = (out?.Attributes ?? {}) as { status?: unknown; result?: unknown };
      const result = a.result && typeof a.result === 'object' && !Array.isArray(a.result) ? (a.result as Record<string, unknown>) : undefined;
      return { ...(typeof a.status === 'string' ? { status: a.status } : {}), ...(result ? { result } : {}) };
    },
  };
}

/** A wait that already ended (timed out, or completed by the API a moment ago) is not an error here. */
const FINISHED_WAIT_ERRORS = new Set(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken']);

export function sfnTaskCompleter(client: DocClient): AwaitOwnerDeps['completeTask'] {
  return async (token, output) => {
    try {
      await client.send(new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify(output) }));
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (!FINISHED_WAIT_ERRORS.has(name)) throw err;
      console.warn(JSON.stringify({ level: 'warn', step: 'await-owner', msg: 'task already finished', reason: name }));
    }
  };
}

let sfn: SFNClient | undefined;

/** Step Functions entry. The state machine passes `{ token, onboardingId, what }` (see waitOwner in provisioning-stack.ts). */
export async function handler(event: AwaitOwnerEvent): Promise<AwaitOwnerResult> {
  parseAwaitOwnerEvent(event);
  const table = requireEnv('TABLE_NAME');
  sfn ??= new SFNClient({});
  return awaitOwner(event, { tasks: ddbTaskStore(awsClients().doc, table), completeTask: sfnTaskCompleter(sfn) });
}
