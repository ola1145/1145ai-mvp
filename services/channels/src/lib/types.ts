export type InboundChannel = 'whatsapp' | 'telegram' | 'webchat';

export interface InboundMessage {
  channel: InboundChannel;
  channelUserId: string;      // WhatsApp: wa_id (or business-scoped user id when Meta supplies it); Telegram: from.id
  chatId: string;             // where to reply (Telegram chat id; WhatsApp = channelUserId)
  channelMessageId: string;   // dedup key
  text: string;
  displayName?: string;
  referralCode?: string;
  receivedAt: string;
}

export interface WebhookResult { statusCode: number; body: string; headers?: Record<string, string> }
