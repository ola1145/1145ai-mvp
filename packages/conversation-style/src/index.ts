/**
 * Detects replies that sound robotic. Used by the eval runner (CI gate), post-call analysis (flags real calls),
 * and agents' own tests. Rules are deterministic so CI results are stable; an LLM judge scores tone separately.
 * The guide behind these rules: .claude/skills/1145-conversation-style/SKILL.md
 */
export type StyleChannel = 'voice' | 'chat';
export type Severity = 'error' | 'warn';
export interface StyleIssue { rule: string; severity: Severity; detail: string }
export interface StyleOptions {
  channel: StyleChannel;
  /** Earlier agent turns in this conversation, oldest first. Enables repetition checks. */
  previousAgentTurns?: readonly string[];
  /** The customer's or owner's first name, if known. Enables name-overuse checks. */
  personName?: string;
  /** First agent turn of a call may contain the required AI/recording disclosure. */
  isFirstTurn?: boolean;
}

const PHRASES: Array<[string, RegExp, Severity]> = [
  ['ai-self-talk', /\bas an ai\b|\b(?:language model|large language model)\b|\bi(?:'m| am) (?:just )?an? (?:ai|bot)\b(?!\s+(?:receptionist|assistant))|\bi don'?t have (?:feelings|emotions)\b/i, 'error'],
  ['scripted-empathy', /\bi (?:completely |totally )?understand your (?:frustration|concern)s?\b/i, 'error'],
  ['inconvenience', /\b(?:apologi[sz]e|sorry) for (?:any|the) inconvenience\b/i, 'error'],
  ['patience', /\bthank you for your patience\b/i, 'error'],
  ['call-center', /\byour (?:call|business) is (?:very )?important to us\b|\bvalued customer\b|\bplease be advised\b|\bat your earliest convenience\b|\bkindly\b|\bas per\b/i, 'error'],
  ['email-speak', /\bi hope this (?:message|email) finds you well\b|\bplease do not hesitate\b|\bfeel free to reach out\b/i, 'error'],
  ['assist-filler', /\b(?:i(?:'d| would) be (?:happy|glad|delighted) to (?:assist|help) you(?: with that)?|how (?:may|can) i assist you(?: today)?)\b/i, 'warn'],
  ['hollow-opener', /^(?:certainly|absolutely|of course|great question|sure thing)[!.,]/i, 'warn'],
  ['anything-else', /\bis there anything else (?:i can|that i can) (?:help|assist) you with\b/i, 'warn'],
  ['hold-script', /\bplease hold\b/i, 'warn'],
];

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const opener = (s: string) => words(s.toLowerCase().replace(/[^\w\s']/g, '')).slice(0, 3).join(' ');
const EMOJI = /\p{Extended_Pictographic}/u;

export function checkReply(reply: string, opts: StyleOptions): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const add = (rule: string, severity: Severity, detail: string) => issues.push({ rule, severity, detail });
  const text = reply.trim();
  if (!text) return [{ rule: 'empty', severity: 'error', detail: 'empty reply' }];

  for (const [rule, re, sev] of PHRASES) {
    const m = re.exec(text);
    if (m) add(rule, sev, `"${m[0]}"`);
  }

  const qs = (text.match(/\?/g) ?? []).length;
  if (qs > 1) add('one-question', 'warn', `${qs} questions in one turn; ask one at a time`);

  if (opts.channel === 'voice') {
    if (/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/.test(text) || /\*\*|__|^#+\s/m.test(text)) add('voice-formatting', 'error', 'lists or markdown cannot be spoken');
    if (/https?:\/\/|www\./i.test(text)) add('voice-url', 'error', 'do not read URLs aloud; offer to send it');
    if (/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/.test(text)) add('voice-iso-date', 'error', 'say dates the way people do ("tomorrow at 3")');
    if (EMOJI.test(text)) add('voice-emoji', 'error', 'emoji in speech');
    if (/\b(?:e\.g\.|i\.e\.|etc\.)/i.test(text)) add('voice-abbrev', 'warn', 'abbreviations sound odd when spoken');
    const total = words(text).length;
    const limit = opts.isFirstTurn ? 45 : 40;
    if (total > limit) add('voice-length', 'error', `${total} words; keep spoken turns under ${limit}`);
    for (const s of sentences(text)) if (words(s).length > 25) { add('voice-long-sentence', 'warn', `${words(s).length}-word sentence`); break; }
  } else {
    if (text.length > 600) add('chat-length', 'warn', `${text.length} chars; chat replies should be short`);
    if (/^#+\s/m.test(text)) add('chat-headers', 'error', 'no headings in chat replies');
  }

  const prev = opts.previousAgentTurns ?? [];
  const last = prev[prev.length - 1];
  if (last && opener(last) && opener(last) === opener(text)) add('repeated-opener', 'warn', `starts like the previous turn ("${opener(text)}")`);
  if (last && last.trim().toLowerCase() === text.toLowerCase()) add('verbatim-repeat', 'error', 'identical to the previous turn');
  const anythingElse = PHRASES.find(([r]) => r === 'anything-else')![1];
  if (anythingElse.test(text) && prev.slice(-3).some((p) => anythingElse.test(p))) add('anything-else-repeat', 'error', 'asked "anything else" again within 3 turns');

  if (opts.personName) {
    const nameRe = new RegExp(`\\b${opts.personName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (nameRe.test(text) && last && nameRe.test(last)) add('name-overuse', 'warn', 'used their name in consecutive turns');
  }
  return issues;
}

/** 100 = natural. Each error costs 15, each warning 5. CI gate: no errors, score >= 85 per turn. */
export function naturalnessScore(issues: readonly StyleIssue[]): number {
  return Math.max(0, 100 - issues.reduce((n, i) => n + (i.severity === 'error' ? 15 : 5), 0));
}

/** Check a whole conversation; returns per-turn issues for agent turns only. */
export function checkConversation(turns: ReadonlyArray<{ role: 'agent' | 'user'; text: string }>, channel: StyleChannel, personName?: string) {
  const agentTurns: string[] = [];
  return turns.flatMap((t, i) => {
    if (t.role !== 'agent') return [];
    const issues = checkReply(t.text, { channel, previousAgentTurns: agentTurns, personName, isFirstTurn: agentTurns.length === 0 });
    agentTurns.push(t.text);
    return [{ turn: i, text: t.text, issues, score: naturalnessScore(issues) }];
  });
}
