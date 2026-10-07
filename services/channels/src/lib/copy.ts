/**
 * The few lines the router itself says (everything else comes from the agents). They follow 1145-conversation-style:
 * short, plain, one question at most, no scripted apologies. Several variants so a repeat does not sound canned.
 */
export const HOLDING_LINES = [
  'Give me a sec, still on it.',
  'Still working on this one, bear with me.',
  "One moment, I'm pulling that together.",
  'Almost there, just a bit longer.',
] as const;

export const SNAG_LINES = [
  'Sorry, I hit a snag on that one. Could you send it again?',
  "That didn't go through on my end. Mind sending it once more?",
] as const;

/** Said once when one person sends far more messages than a person types in a minute (the router's per-identity cap, SEC-25). */
export const RATE_LIMIT_LINES = [
  "That's a lot at once, so give me a minute to catch up. Then send what you still need.",
  'Lots of messages came in at once. Give me a minute to catch up, then send it again.',
] as const;

export const PAUSED_LINE =
  "Your account's paused right now. Update billing in your dashboard and I'm right back, or reply HELP and a person will pick this up.";

/** What the owner reads after replying CONFIRM <code>. The tool API decides the outcome; the words are ours. */
export const APPLIED_LINE = "Done, that's live now.";
export const CODE_NOT_FOUND_LINE = "I can't find a change waiting under that code. It may have expired, so tell me what you'd like and I'll set it up again.";
export const STEP_UP_LINE = 'That one needs a quick confirmation in your dashboard before it goes live.';

/** Stable pick so a retried message gets the same wording, while different messages vary. */
export function pickLine<T extends readonly string[]>(lines: T, seed: string): T[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return lines[h % lines.length] as T[number];
}
