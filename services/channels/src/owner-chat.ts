/**
 * POST /v1/owner-chat/messages (Cognito): enqueue to FIFO; replies are published to /owners/<sub>/chat.
 * Owner: issue C3 (tasks/C3.md). Contract: contracts/openapi/channels.yaml.
 */
export async function handler(_event: unknown): Promise<unknown> {
  throw new Error('owner-chat not implemented (C3)');
}
