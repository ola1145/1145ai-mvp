import { routeInbound, type RouterDeps } from './router.js';
import type { InboundMessage } from './lib/types.js';

interface SqsEvent { Records: Array<{ messageId: string; body: string }> }

/** SQS FIFO consumer. Reports partial batch failures so one bad message does not block a user's queue forever (DLQ after 5). */
export async function processBatch(event: SqsEvent, deps: RouterDeps) {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const r of event.Records) {
    try {
      await routeInbound(JSON.parse(r.body) as InboundMessage, deps);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', sqsMessageId: r.messageId, err: String(err) }));
      batchItemFailures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures };
}

// TODO(W1-12): prodDeps — DynamoDB route reads, AgentCore InvokeAgentRuntime (runtimeSessionId = sessionId, >= 33 chars),
// WhatsApp Cloud API / Telegram sendMessage senders, Secrets Manager. Keep FIFO ordering: process records sequentially.
export const handler = async (_event: SqsEvent) => { throw new Error('router prodDeps not wired (W1-12)'); };
