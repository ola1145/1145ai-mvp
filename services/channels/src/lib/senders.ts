import type { ReplyTarget, RouterDeps } from '../router.js';

export interface SenderDeps {
  /** Publish an agent reply to AppSync Events /owners/<sub>/chat. */
  publishOwnerChat(sub: string, text: string, meta?: { inReplyTo?: string }): Promise<void>;
  /** Telegram sendMessage (retrying 429/5xx). */
  sendTelegram(chatId: string, text: string): Promise<void>;
}

/**
 * Per-channel reply delivery. The destination always comes from the verified inbound message:
 * web chat -> the Cognito sub that authenticated the request, Telegram -> the chat the update came from.
 */
export function createSender(deps: SenderDeps): RouterDeps['send'] {
  return async (to: ReplyTarget, text: string): Promise<void> => {
    switch (to.channel) {
      case 'webchat':
        // The app clears its "typing" state on the first reply, whether that is a holding line or the real answer (CR C3-2).
        return deps.publishOwnerChat(to.channelUserId, text, { inReplyTo: to.channelMessageId });
      case 'telegram':
        return deps.sendTelegram(to.chatId, text);
      case 'whatsapp':
        // Phase 2 (ADR-0005): the WhatsApp Cloud API sender is deliberately not wired in the MVP.
        throw new Error('whatsapp replies are disabled until Phase 2');
      default:
        throw new Error(`no sender for channel ${String(to.channel)}`);
    }
  };
}
