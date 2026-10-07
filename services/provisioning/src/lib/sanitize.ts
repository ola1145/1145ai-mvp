/**
 * Scraped websites, listings and social profiles are UNTRUSTED. They become candidate facts with provenance,
 * verified=false, and instruction-like passages are flagged for the owner's "is this right?" card.
 * Nothing here is ever concatenated into a system prompt.
 *
 * Everything in this file is pure text processing: no network, no storage, no model. The crawl lives in
 * steps/scrape-knowledge.ts; this is what it does with each page.
 */

export type FlagName =
  | 'override' | 'persona' | 'prompt-ref' | 'role-tag' | 'exfil' | 'tool-call' | 'ai-addressed' | 'directive' | 'obfuscated';
export type CandidateKind = 'price' | 'hours' | 'info';

export interface KnowledgeCandidate {
  text: string;
  /** URL of the page the text was read from. */
  source: string;
  /** Always false here. Only the owner's confirmation (D3) can make a fact verified. */
  verified: false;
  /** Names from FLAG_REASONS. Any flag means "a person looks at this first, and it never reaches an agent". */
  flags: string[];
  kind: CandidateKind;
  /** Price candidates only: what the price seems to be for, when the line says so plainly. */
  label?: string;
  amountCents?: number;
  /** Set when the page gives a range ("$90-$140"); amountCents is then the low end. */
  maxAmountCents?: number;
}

/** Plain words for the owner's card, one per flag. Chat style (checked in test/sanitize.test.ts). */
export const FLAG_REASONS: Record<FlagName, string> = {
  override: 'It tells whoever reads it to ignore their earlier instructions.',
  persona: 'It tries to give the assistant a different role.',
  'prompt-ref': "It talks about the assistant's own setup.",
  'role-tag': 'It has markup made to look like instructions to an assistant.',
  exfil: 'It asks for private details to be shown or sent.',
  'tool-call': 'It tells an assistant to run something.',
  'ai-addressed': "It's written for an AI to read, not for your customers.",
  directive: 'It tells the assistant what to say to customers.',
  obfuscated: 'It has hidden or look-alike characters in it.',
};

// ---------------------------------------------------------------------------------------------------------------------
// Instruction-like detection
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Tuned to catch text written to steer a model while leaving ordinary business copy alone ("function room",
 * "aftercare instructions", "call the front desk"). A false alarm costs the owner one tap and keeps a fact out of the
 * agent; a miss is the expensive case, so each pattern leans on the verb a person would not write to a customer.
 */
const INSTRUCTION_PATTERNS: Array<[Exclude<FlagName, 'obfuscated'>, RegExp]> = [
  ['override', /\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:instructions?|rules?|prompts?|above|previous|prior|guidelines?|directives?)\b/i],
  ['override', /\b(?:do not|don['’]t)\s+follow\b.{0,30}\b(?:instructions?|rules?|guidelines?)\b/i],
  ['persona', /\byou are (?:now|an?|the)\b.{0,40}\b(?:assistant|ai|bot|agent|model)\b/i],
  ['persona', /\b(?:from now on|henceforth),?\s+you\s+(?:are|must|only|always|never|answer|respond|reply|speak|act|should|shall)\b/i],
  ['persona', /\bpretend (?:to be|you(?:['’]re| are))\b/i],
  ['persona', /\bact as (?:an? |the )?(?:\w+ ){0,2}(?:assistant|ai|bot|model|admin|administrator|developer)\b/i],
  ['persona', /\b(?:your|the assistant['’]?s?) (?:new|real|true) (?:role|persona|identity|task|job)\b/i],
  ['prompt-ref', /\b(?:system|developer)\s*(?:prompt|message|instructions?)\b/i],
  ['prompt-ref', /\b(?:your|the|my)\s+(?:initial|original|hidden|secret|real)\s+(?:prompt|instructions?|message)\b/i],
  ['role-tag', /<\s*\/?\s*(?:system|assistant|user|instructions?|tool)\b[^>]*>/i],
  ['role-tag', /<\|[a-z_]{2,20}\|>|\[\/?INST\]|<<\/?SYS>>|^#{2,}\s*(?:system|instructions?)\b/im],
  ['exfil', /\b(?:reveal|print|show|send|leak|output|repeat|disclose|email|post|forward)\b.{0,40}\b(?:prompt|secrets?|tokens?|passwords?|api[ -]?keys?|credentials?)\b/i],
  ['tool-call', /\b(?:call|invoke|execute|run|trigger)\s+(?:the\s+|your\s+|a\s+|an\s+|any\s+)?(?:\w+\s+){0,2}?(?:tool|function|api)\b(?!\s+(?:room|hall|space|venue|suite|cent(?:er|re)|area|rental|shed|box|kit|bench|library|sales))/i],
  ['tool-call', /\b(?:tool|function)_(?:calls?|use)\b/i],
  ['ai-addressed', /\b(?:note|message|attention|attn|instructions?|reminder)\s*(?:to|for)\s+(?:the\s+)?(?:ai|a\.i\.|llm|chat\s?bots?|language models?|ai\s+(?:agents?|assistants?|systems?|models?))\b/i],
  ['ai-addressed', /\bif you(?:['’]re| are) (?:an? )?(?:ai|llm|chat\s?bot|language model|large language model|automated (?:agent|system))\b/i],
  ['directive', /\bwhen (?:asked|anyone asks|(?:a |the |any )?(?:user|customer|caller|visitor|client|person)s? (?:asks?|calls?))\b.{0,60}\b(?:say|answer|respond|reply|tell|quote)\b/i],
];

/** "Don't forget the house rules" is ordinary copy; the negated verb is removed before looking for the pattern. */
const NEGATED_VERB = /\b(?:please\s+)?(?:do not|don['’]t|never)\s+(?:forget|ignore)\b/gi;

function patternFlags(text: string): string[] {
  const t = text.replace(NEGATED_VERB, ' ');
  const out: string[] = [];
  for (const [name, re] of INSTRUCTION_PATTERNS) if (!out.includes(name) && re.test(t)) out.push(name);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Normalisation: read the text the way a person (and a model) would, so tricks to hide a sentence don't work
// ---------------------------------------------------------------------------------------------------------------------

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
/** Zero-width, bidi-control, soft hyphen, variation and other invisible or control characters (tab, LF and CR stay). */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF9-\uFFFB]/gu;

export interface NormalizedText {
  /** What a reader sees: compatibility-normalised, invisible characters removed, whitespace collapsed. */
  text: string;
  /** ASCII hidden in Unicode "tag" characters (invisible on screen, readable by a model). Never stored as text. */
  hidden: string;
  /** True when zero-width or control characters had to be removed. */
  invisible: boolean;
}

export function normalizeScraped(raw: string): NormalizedText {
  let hidden = '';
  let s = String(raw).replace(TAG_CHARS, (c) => {
    const code = (c.codePointAt(0) ?? 0) - 0xe0000;
    if (code >= 0x20 && code < 0x7f) hidden += String.fromCharCode(code);
    return '';
  });
  s = s.normalize('NFKC');
  const before = s.length;
  s = s.replace(/(?<=\p{L})\u200D(?=\p{L})/gu, '').replace(INVISIBLE, ''); // a joiner between letters splits a word; in emoji it stays
  const invisible = s.length !== before;
  return { text: s.replace(/\s+/g, ' ').trim(), hidden: hidden.trim(), invisible };
}

/** A word that mixes Latin with Cyrillic or Greek letters is almost always a look-alike trick ("ignоre"). */
function hasMixedScript(text: string): boolean {
  for (const w of text.match(/\p{L}+/gu) ?? []) {
    if (/\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w)) return true;
  }
  return false;
}

function flagsOf(n: NormalizedText, raw?: string): string[] {
  const flags = patternFlags(n.hidden ? `${n.text} ${n.hidden}` : n.text);
  const evaded = n.invisible && raw !== undefined && patternFlags(raw).length < flags.length;
  if (n.hidden || hasMixedScript(n.text) || evaded) flags.push('obfuscated');
  return flags;
}

/** Names of the instruction-like patterns found in `text` (empty for ordinary business copy). */
export function detectInstructionLike(text: string): string[] {
  return flagsOf(normalizeScraped(text), text);
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', cent: '¢', pound: '£', euro: '€',
};

/** One pass, so "&amp;lt;" becomes "&lt;" and not "<". Unknown or invalid references become a space. */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (_m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? ' ';
    const cp = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
  });
}

const BLOCK_TAG = /<\/?(?:p|div|br|li|ul|ol|tr|table|thead|tbody|tfoot|h[1-6]|section|article|header|footer|nav|main|aside|blockquote|pre|hr|form|dl|dt|dd|figure|figcaption|address|option|select|fieldset|legend|details|summary|body|html)\b[^>]*>/gi;

/**
 * Visible text of an HTML page. Script, style and similar are dropped whole, including one left open because the page
 * was cut off at the size limit. Block tags become line breaks, table cells a space, and inline tags nothing, so a word
 * split by an empty tag ("ig<b></b>nore") reads as one word.
 */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|iframe)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(BLOCK_TAG, '\n')
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/<[a-z/!][^>]*$/i, '');
  return decodeEntities(s)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
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

// ---------------------------------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------------------------------

const MAX_TEXT = 300;
const MAX_PIECE = 240;
const MAX_SEGMENT = 1000;
const MAX_SEGMENTS = 3000;
const MIN_INFO = 15;
/** Per page; the crawl applies the same caps again across pages. */
export const CANDIDATE_CAPS = { flagged: 10, price: 25, hours: 10, info: 25 } as const;
const MAX_PRICE_CENTS = 10_000_000;

const ABBREVIATION = /\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|mr|mrs|ms|dr|st|ave|rd|blvd|ste|no|inc|co|vs|approx)\./gi;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9$"'“(\[])/;

function splitLong(seg: string): string[] {
  if (seg.length <= MAX_SEGMENT) return [seg];
  const out: string[] = [];
  let cur = '';
  for (const w of seg.split(/\s+/)) {
    if (cur && cur.length + 1 + w.length > MAX_SEGMENT) { out.push(cur); cur = w.slice(0, MAX_SEGMENT); } else cur = cur ? `${cur} ${w}` : w.slice(0, MAX_SEGMENT);
  }
  if (cur) out.push(cur);
  return out;
}

/** Lines, then sentences ("Mon. 9am" and "Dr. Lee" stay whole), then pieces small enough to judge one at a time. */
function segmentText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const guarded = line.replace(ABBREVIATION, (m) => `${m.slice(0, -1)}\u0001`);
    for (const part of guarded.split(SENTENCE_BREAK)) {
      const seg = part.replace(/\u0001/g, '.').trim();
      if (seg) out.push(...splitLong(seg));
      if (out.length >= MAX_SEGMENTS) return out;
    }
  }
  return out;
}

const cap = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
};

const dedupeKey = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}$]+/gu, ' ').trim();

// -- prices -----------------------------------------------------------------------------------------------------------

const PRICE_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?:\s?(?:-|–|—|to)\s?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?)?(?!\d)/gi;

const toCents = (whole: string | undefined, frac: string | undefined): number | undefined => {
  if (whole === undefined) return undefined;
  const cents = Number(whole.replace(/,/g, '')) * 100 + (frac ? Number(frac) : 0);
  return cents > 0 && cents <= MAX_PRICE_CENTS ? cents : undefined;
};

interface PriceHit { index: number; length: number; min: number; max?: number }

function priceHits(piece: string): PriceHit[] {
  const hits: PriceHit[] = [];
  for (const m of piece.matchAll(PRICE_RE)) {
    const min = toCents(m[1], m[2]);
    if (min === undefined) continue;
    const max = toCents(m[3], m[4]);
    hits.push({ index: m.index ?? 0, length: m[0].length, min, ...(max !== undefined && max > min ? { max } : {}) });
  }
  return hits;
}

const LABEL_FILLER = /\b(?:from|starting at|starts at|start at|only|just|for|at|is|are|costs?|prices?d?|each|per)\s*$/i;

function labelFor(piece: string, hit: PriceHit): string | undefined {
  let rest = `${piece.slice(0, hit.index)} ${piece.slice(hit.index + hit.length)}`;
  if (/[$\d]/.test(rest)) return undefined;
  const colon = rest.split(':').map((p) => p.trim()).filter(Boolean);
  rest = colon[colon.length - 1] ?? '';
  for (let prev = ''; prev !== rest;) { prev = rest; rest = rest.replace(/^[\s\-–—:|•·.,;()]+|[\s\-–—:|•·.,;()]+$/g, '').replace(LABEL_FILLER, '').trim(); }
  return rest.length >= 2 && rest.length <= 60 && rest.split(/\s+/).length <= 6 && /^[A-Za-z][A-Za-z &'’/-]*$/.test(rest) ? rest : undefined;
}

/** A line with two or more prices ("Cut $35, shave $20; trim $15") is judged one price at a time. */
function pieces(segment: string): string[] {
  if (priceHits(segment).length < 2) return [segment];
  return segment.split(/\s*(?:[;|•·]|,\s)\s*/).map((p) => p.trim()).filter(Boolean);
}

// -- hours ------------------------------------------------------------------------------------------------------------

const DAY = /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b/i;
const TIME_RANGE = /\b(\d{1,2})(?::[0-5]\d)?\s?([ap]\.?m\.?)?\s?(?:-|–|—|to|until|till)\s?(\d{1,2})(?::[0-5]\d)?\s?([ap]\.?m\.?)?(?![\d:])/gi;

function hasTimeRange(piece: string): 'strong' | 'weak' | undefined {
  let best: 'strong' | 'weak' | undefined;
  for (const m of piece.matchAll(TIME_RANGE)) {
    const [whole, a, ap, b, bp] = m;
    const [h1, h2] = [Number(a), Number(b)];
    if (h1 > 24 || h2 > 24 || ((ap || bp) && (h1 > 12 || h2 > 12 || h1 === 0 || h2 === 0))) continue;
    if (ap || bp || /\d:\d\d/.test(whole)) return 'strong';
    best = 'weak';
  }
  return best;
}

function looksLikeHours(piece: string): boolean {
  const range = hasTimeRange(piece);
  if (range === 'strong') return true;
  if (range === 'weak' && (DAY.test(piece) || /\bhours?\b/i.test(piece))) return true;
  if (DAY.test(piece) && /\bclosed\b/i.test(piece)) return true;
  return /\bopen\b.{0,20}\b(?:24\/7|24 hours|around the clock|every day|daily|seven days)\b/i.test(piece);
}

// -- plain facts ------------------------------------------------------------------------------------------------------

const USEFUL_INFO = /\b(?:walk-?ins?|appointments?|reservations?|parking|cancel\w*|deposits?|payments?|cash|credit cards?|debit|accept\w*|insur\w+|licensed|certified|bonded|warrant(?:y|ies)|guarantee\w*|estimates?|emergenc\w+|same[- ]day|deliver\w+|service area|serving|located|family[- ]owned|owned and operated|since (?:19|20)\d\d|years? (?:of )?experience|wheelchair|accessible|financing|free (?:quotes?|consultations?)|pet[- ]friendly|wi-?fi)\b|\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Hwy)\b/i;
const BOILERPLATE = /©|\ball rights reserved\b|\bcookies?\b|\bprivacy policy\b|\bterms (?:of|and)\b|\bsubscribe\b|\bnewsletter\b|\bskip to\b|\bsign up\b|\blog ?in\b/i;

function classify(piece: string, source: string): KnowledgeCandidate | undefined {
  const base = { source, verified: false as const, flags: [] as string[] };
  if (piece.length <= MAX_PIECE) {
    const hits = priceHits(piece);
    if (hits.length >= 1) {
      const hit = hits[0]!;
      const label = hits.length === 1 ? labelFor(piece, hit) : undefined;
      return { ...base, text: piece, kind: 'price', amountCents: hit.min, ...(hit.max !== undefined ? { maxAmountCents: hit.max } : {}), ...(label ? { label } : {}) };
    }
    if (looksLikeHours(piece)) return { ...base, text: piece, kind: 'hours' };
  }
  if (piece.length >= MIN_INFO && piece.split(/\s+/).length >= 2 && USEFUL_INFO.test(piece) && !BOILERPLATE.test(piece)) {
    return { ...base, text: cap(piece, MAX_TEXT), kind: 'info' };
  }
  return undefined;
}

/**
 * Candidate facts from one page: instruction-like passages (flagged, kept so the owner can see them, never parsed for
 * prices or hours), then prices, hours and a few useful plain facts, each with the page URL. Always unverified.
 * Capped per kind and de-duplicated, so a page cannot flood the owner's confirmation card.
 */
export function toCandidates(html: string, source: string): KnowledgeCandidate[] {
  const items = segmentText(htmlToText(html)).map((raw) => ({ raw, n: normalizeScraped(raw) })).filter((x) => x.n.text);
  const flags = items.map((x) => flagsOf(x.n, x.raw));
  // An instruction split across two neighbouring lines ("Please ignore" / "the previous instructions") is still one.
  for (let i = 0; i + 1 < items.length; i++) {
    for (const f of patternFlags(`${items[i]!.n.text} ${items[i + 1]!.n.text}`)) {
      if (!flags[i]!.includes(f) && !flags[i + 1]!.includes(f)) { flags[i]!.push(f); flags[i + 1]!.push(f); }
    }
  }

  const out: KnowledgeCandidate[] = [];
  const seen = new Set<string>();
  const count = { flagged: 0, price: 0, hours: 0, info: 0 };
  const keep = (c: KnowledgeCandidate) => {
    const key = dedupeKey(c.text);
    const bucket = c.flags.length ? 'flagged' : c.kind;
    if (!key || seen.has(key) || count[bucket] >= CANDIDATE_CAPS[bucket]) return;
    seen.add(key); count[bucket]++; out.push(c);
  };

  items.forEach((x, i) => {
    const f = flags[i]!;
    if (f.length) { keep({ text: cap(x.n.text, MAX_TEXT), source, verified: false, flags: f, kind: 'info' }); return; }
    for (const piece of pieces(x.n.text)) {
      const c = classify(piece, source);
      if (c) keep(c);
    }
  });
  return out;
}
