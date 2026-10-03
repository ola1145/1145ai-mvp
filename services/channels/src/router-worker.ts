import { routeInbound, type RouterDeps } from './router.js';
import { createProdDeps } from './router-deps.js';
import type { InboundMessage } from './lib/types.js';

interface SqsEvent { Records: Array<{ messageId: string; body: string }> }

/**
 * SQS FIFO consumer. Records are processed sequentially to keep per-user ordering. Reports partial batch failures so one
 * bad message does not block a user's queue forever (DLQ after 5). Replays are harmless: routeInbound claims each message
 * id first, so a redelivered or duplicated message never invokes an agent twice.
 */
export async function processBatch(event: SqsEvent, deps: RouterDeps) {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const r of event.Records) {
    try {
      await routeInbound(JSON.parse(r.body) as InboundMessage, deps);
    } catch (err) {
      // Log the error only: message bodies are owner free text and stay out of logs.
      console.error(JSON.stringify({ level: 'error', sqsMessageId: r.messageId, err: String(err) }));
      batchItemFailures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures };
}

let deps: RouterDeps | undefined;
export const handler = async (event: SqsEvent) => processBatch(event, (deps ??= createProdDeps()));
