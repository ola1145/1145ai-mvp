/**
 * Scraped websites, listings and social profiles are UNTRUSTED. They become candidate facts with provenance,
 * verified=false, and instruction-like passages are flagged for the owner's "is this right?" card.
 * Nothing here is ever concatenated into a system prompt.
 */
export interface KnowledgeCandidate {
  text: string;
  source: string;
  verified: false;
  flags: string[];
}

const INSTRUCTION_PATTERNS: Array<[string, RegExp]> = [
  ['override', /\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|rules?|prompts?|above|previous)\b/i],
  ['persona', /\byou are (now|an?|the)\b.{0,40}\b(assistant|ai|bot|agent|model)\b/i],
  ['prompt-ref', /\b(system|developer)\s*(prompt|message|instructions?)\b/i],
  ['role-tag', /<\s*\/?\s*(system|assistant|user|instructions?|tool)\b[^>]*>/i],
  ['exfil', /\b(reveal|print|show|send)\b.{0,40}\b(prompt|secret|token|password|api key)\b/i],
  ['tool-call', /\b(call|invoke|use)\b.{0,20}\b(tool|function)\b/i],
];

export function detectInstructionLike(text: string): string[] {
  return INSTRUCTION_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function chunk(text: string, maxChars = 700): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + ' ' + s).length > maxChars) { out.push(cur); cur = s; } else { cur = cur ? `${cur} ${s}` : s; }
  }
  if (cur) out.push(cur);
  return out.map((c) => c.slice(0, maxChars));
}

export function toCandidates(html: string, source: string): KnowledgeCandidate[] {
  return chunk(htmlToText(html)).map((text) => ({ text, source, verified: false as const, flags: detectInstructionLike(text) }));
}
