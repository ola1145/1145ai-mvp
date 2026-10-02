import { verifyMetaSignature, parseWhatsAppReferral } from './lib/verify.js';
import type { InboundMessage, WebhookResult } from './lib/types.js';

export interface WebhookEvent {
  requestContext: { http: { method: string } };
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface WhatsAppDeps {
  appSecret(): Promise<string>;
  verifyToken(): Promise<string>;
  /** FIFO: group = sender (ordering per user), dedup = message id (Meta retries). */
  enqueue(msg: InboundMessage): Promise<void>;
  now(): Date;
}

interface MetaPayload {
  entry?: Array<{ changes?: Array<{ value?: {
    contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
    messages?: Array<{ from?: string; id?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } } }>;
  } }> }>;
}

/** Acknowledge fast: verify, normalize, enqueue, 200. No agent call here (Add-2). */
export async function whatsappWebhook(event: WebhookEvent, deps: WhatsAppDeps): Promise<WebhookResult> {
  const method = event.requestContext.http.method;
  if (method === 'GET') {
    const q = event.queryStringParameters ?? {};
    const ok = q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === (await deps.verifyToken());
    return ok ? { statusCode: 200, body: q['hub.challenge'] ?? '' } : { statusCode: 403, body: 'forbidden' };
  }

  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  const sig = event.headers['x-hub-signature-256'] ?? event.headers['X-Hub-Signature-256'];
  if (!verifyMetaSignature(raw, sig, await deps.appSecret())) return { statusCode: 401, body: 'bad signature' };

  let payload: MetaPayload;
  try { payload = JSON.parse(raw) as MetaPayload; } catch { return { statusCode: 400, body: 'bad json' }; }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      const names = new Map((v?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v?.messages ?? []) {
        if (!m.from || !m.id) continue;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? `[${m.type ?? 'unsupported'} message]`;
        await deps.enqueue({
          channel: 'whatsapp', channelUserId: m.from, chatId: m.from, channelMessageId: m.id, text,
          displayName: names.get(m.from), referralCode: parseWhatsAppReferral(text), receivedAt: deps.now().toISOString(),
        });
      }
      // statuses[] (sent/delivered/read/failed) -> TODO(W1-12): forward failed statuses to EventBridge for alerting.
    }
  }
  return { statusCode: 200, body: 'ok' };
}
