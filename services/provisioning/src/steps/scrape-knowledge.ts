/**
 * Step: scrape-knowledge
 *
 * Reads the site (and up to three listings) the owner gave us, turns what it finds into unverified candidate facts,
 * and writes them as FACT# items for the owner's "is this right?" card. Everything on those pages is data: it is
 * flagged when it reads like instructions, it is never acted on, and nothing here can make a fact verified.
 *
 * Limits (all enforced here, not trusted to the fetcher): 10 page requests, 5 s each, 2 MB read in total, and an
 * overall deadline inside the Lambda timeout. robots.txt is read first for every site and obeyed (RFC 9309).
 *
 * Safety:
 *  - tenantId and onboardingId come from the workflow state the start endpoint set; nothing on a page can change
 *    which tenant a fact is written under.
 *  - URLs are owner input, so only public http(s) addresses on ordinary ports are fetched (checkFetchUrl, and a DNS
 *    check in httpFetchPage); redirects are followed by hand and every hop is checked again. Residual risk: DNS can
 *    change between our lookup and the connection (rebinding). The Lambda is not in a VPC and this step is granted no
 *    secrets, so there is no private network or credential on the other side for a rebinding answer to reach.
 *  - The result returned to the workflow carries counts only, never text from a page.
 *  - Re-running is safe: facts are written with a condition, so a retry never resets what the owner decided.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys } from '@1145/shared';
import { CANDIDATE_CAPS, candidateKey, toCandidates, type CandidateKind, type KnowledgeCandidate } from '../lib/sanitize.js';

export const BOT_TOKEN = '1145ai-bot';
export const USER_AGENT = `${BOT_TOKEN}/1.0 (+https://1145.ai; one-time read of the pages a business owner gave us)`;

export const DEFAULT_LIMITS = {
  maxPages: 10,
  pageTimeoutMs: 5_000,
  maxTotalBytes: 2 * 1024 * 1024,
  /** One page may not use the whole budget. */
  maxPageBytes: 512 * 1024,
  maxRobotsBytes: 128 * 1024,
  maxRedirects: 3,
  /** Stop starting requests after this long. The step's Lambda timeout is 60 s (provisioning-stack.ts). */
  deadlineMs: 45_000,
  maxListings: 3,
  maxQueue: 300,
};
export type Limits = typeof DEFAULT_LIMITS;

/** Smaller than this is not worth a request. */
const MIN_USEFUL_BYTES = 1024;

export type SkipReason =
  | 'no-website' | 'blocked-url' | 'robots' | 'robots-unavailable' | 'timeout' | 'fetch-error' | 'http-error'
  | 'not-html' | 'redirect-limit' | 'page-limit' | 'byte-budget' | 'deadline';

export interface FetchedPage { status: number; contentType: string; body: string; location?: string }
/** `maxBytes` is how much the caller will accept; `signal` aborts at the page timeout. Never follow redirects. */
export type PageFetcher = (url: string, opts: { signal: AbortSignal; maxBytes: number }) => Promise<FetchedPage>;

/** FACT#<fid> item as written by this step. Additive attributes are documented in contracts/CHANGE_REQUESTS/D6-3.md. */
export interface FactItem {
  PK: string;
  SK: string;
  text: string;
  source: string;
  verified: false;
  flaggedInstructionLike: boolean;
  flags: string[];
  kind: CandidateKind;
  label?: string;
  amountCents?: number;
  maxAmountCents?: number;
  onboardingId: string;
  scrapedAt: string;
}
export interface FactStore {
  /** Writes only if the item does not exist. Resolves false when it already did. */
  putIfAbsent(item: FactItem): Promise<boolean>;
}

/** The workflow state. Only these four fields are read; everything else in it is ignored. */
export interface ScrapeInput { onboardingId?: unknown; tenantId?: unknown; website?: unknown; listings?: unknown; [key: string]: unknown }
export interface ScrapeDeps {
  fetchPage: PageFetcher;
  facts: FactStore;
  limits?: Partial<Limits>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}
export interface ScrapeResult {
  pagesFetched: number;
  bytesRead: number;
  candidates: number;
  flagged: number;
  stored: number;
  skipped: Partial<Record<SkipReason, number>>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Which addresses we are willing to fetch
// ---------------------------------------------------------------------------------------------------------------------

export class FetchBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'FetchBlockedError'; }
}

const BLOCKED_TLDS = new Set(['localhost', 'local', 'internal', 'localdomain', 'home', 'lan', 'corp', 'intranet', 'private']);

/** A public web address: http(s), no credentials, standard port, a real hostname (not an IP, not an internal name). */
export function checkFetchUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new FetchBlockedError('not a usable address');
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new FetchBlockedError('not a web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchBlockedError('not http or https');
  if (u.username || u.password) throw new FetchBlockedError('address carries credentials');
  if (!['', '80', '443'].includes(u.port)) throw new FetchBlockedError('unusual port');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.includes(':') || isIP(host) || !/^[a-z0-9.-]+$/.test(host)) throw new FetchBlockedError('not a public hostname');
  if (!host.includes('.') || BLOCKED_TLDS.has(host.slice(host.lastIndexOf('.') + 1))) throw new FetchBlockedError('internal hostname');
  u.hash = '';
  return u;
}

const v4Parts = (a: string): number[] | undefined => {
  const p = a.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : undefined;
};

function publicV4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseV6(addr: string): number[] | undefined {
  let a = (addr.toLowerCase().split('%')[0] ?? '');
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) {
    const p = v4Parts(mapped[2]!);
    if (!p) return undefined;
    a = `${mapped[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return undefined;
  const nums = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : undefined;
}

/** False for anything that is not a routable public address (private, loopback, link-local, reserved, malformed). */
export function isPublicAddress(addr: string): boolean {
  const version = isIP(addr);
  if (version === 4) { const p = v4Parts(addr); return !!p && publicV4(p); }
  if (version !== 6) return false;
  const g = parseV6(addr);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
  if (g.slice(0, 7).every((x) => x === 0) && g7 <= 1) return false; // :: and ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return publicV4(embedded); // IPv4-mapped
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return publicV4(embedded); // NAT64
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xfe00) === 0xfc00 || (g0 & 0xff00) === 0xff00) return false; // link-local, unique local, multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return publicV4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]); // 6to4
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// robots.txt (RFC 9309)
// ---------------------------------------------------------------------------------------------------------------------

interface Rule { allow: boolean; pattern: string; anchored: boolean; len: number }
export interface RobotsRules { rules: Rule[] }

/**
 * Rules that apply to this crawler: the group naming it if there is one, else the `*` group. Groups for the same
 * agent merge. Bounded (5000 lines, 1000 rules, 1000 characters each) so a hostile file cannot make matching slow.
 */
export function parseRobots(text: string, token: string = BOT_TOKEN): RobotsRules {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let cur: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\r|\n/).slice(0, 5000)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line.split('#')[0] ?? '');
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!;
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!cur || !value || cur.rules.length >= 1000) continue; // an empty value matches nothing
      const anchored = value.endsWith('$');
      cur.rules.push({ allow: field === 'allow', pattern: (anchored ? value.slice(0, -1) : value).slice(0, 1000), anchored, len: value.length });
    }
  }
  const me = token.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && a !== '' && me.startsWith(a)));
  return { rules: (named.length ? named : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules) };
}

/** `*` matches any run of characters, a trailing `$` pins the end. Greedy left-to-right: linear, no backtracking. */
function globMatch(rule: Rule, s: string): boolean {
  const parts = rule.pattern.split('*');
  const first = parts[0]!;
  if (!s.startsWith(first)) return false;
  if (parts.length === 1) return rule.anchored ? s === first : true;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = s.indexOf(parts[i]!, pos);
    if (at < 0) return false;
    pos = at + parts[i]!.length;
  }
  const last = parts[parts.length - 1]!;
  if (rule.anchored) return s.length - last.length >= pos && s.endsWith(last);
  return s.indexOf(last, pos) >= 0;
}

/** Longest matching rule wins; on a tie Allow wins; no match means allowed. `pathAndQuery` is `pathname + search`. */
export function robotsAllows(r: RobotsRules, pathAndQuery: string): boolean {
  const path = (pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`).slice(0, 2048);
  if (path === '/robots.txt') return true;
  let best: Rule | undefined;
  for (const rule of r.rules) {
    if (!globMatch(rule, path)) continue;
    if (!best || rule.len > best.len || (rule.len === best.len && rule.allow && !best.allow)) best = rule;
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The real fetcher
// ---------------------------------------------------------------------------------------------------------------------

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const mediaType = (contentType: string): string => (contentType.split(';')[0] ?? '').trim().toLowerCase();
/** HTML, XHTML, plain text, or no type at all (some small sites send none). */
export const isPageContentType = (contentType: string): boolean => { const t = mediaType(contentType); return t === '' || PAGE_TYPES.has(t); };

/**
 * GET without credentials, without cookies and without following redirects (the step follows them, checking each hop).
 * The name is resolved first and refused if any answer is not a public address. The body is read only up to `maxBytes`
 * and the connection is then closed; a file that is not a page is not downloaded at all.
 */
export function httpFetchPage(opts: { fetchImpl?: typeof fetch; lookup?: Lookup } = {}): PageFetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  return async (rawUrl, { signal, maxBytes }) => {
    const url = checkFetchUrl(rawUrl);
    const answers = await lookup(url.hostname);
    if (!answers.length || answers.some((a) => !isPublicAddress(a.address))) throw new FetchBlockedError('hostname does not resolve to a public address');
    const res = await fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', 'Accept-Language': 'en-US,en;q=0.8' },
    });
    const contentType = (res.headers.get('content-type') ?? '').trim();
    const location = res.headers.get('location') ?? undefined;
    const isRedirect = res.status >= 300 && res.status < 400;
    const reader = !isRedirect && isPageContentType(contentType) ? res.body?.getReader() : undefined;
    if (!reader) { await res.body?.cancel().catch(() => undefined); return { status: res.status, contentType, body: '', ...(location ? { location } : {}) }; }
    const chunks: Uint8Array[] = [];
    let read = 0;
    try {
      while (read < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = value.length > maxBytes - read ? value.subarray(0, maxBytes - read) : value;
        chunks.push(part);
        read += part.length;
      }
    } finally { await reader.cancel().catch(() => undefined); }
    let decoder = new TextDecoder('utf-8');
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
    if (charset) { try { decoder = new TextDecoder(charset); } catch { /* unknown label: keep utf-8 */ } }
    return { status: res.status, contentType, body: decoder.decode(Buffer.concat(chunks)), ...(location ? { location } : {}) };
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------------------------

const STATIC_ASSET = /\.(?:jpe?g|png|gif|webp|svg|ico|bmp|avif|pdf|zip|gz|docx?|xlsx?|pptx?|mp[34]|mov|avi|wmv|css|m?js|json|xml|txt|woff2?|ttf|eot|apk|exe|dmg)$/i;
/** Pages that tend to hold prices, hours and policies are read first when there are more links than page budget. */
const USEFUL_PATH = /(?:pric|rate|cost|fee|service|menu|hour|contact|about|location|visit|faq|book|appoint|special|package|treatment|repair|what-we)/i;
const bareHost = (u: URL) => u.hostname.replace(/^www\./, '');

export function extractLinks(html: string, base: URL): Array<{ url: URL; score: number }> {
  const cleaned = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(script|style|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  const found = new Map<string, { url: URL; score: number }>();
  for (const m of cleaned.matchAll(/<a\b[^>]{0,500}?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    if (found.size >= 200) break;
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/gi, '&').trim();
    if (!raw || raw.startsWith('#') || /^(?:mailto|tel|sms|javascript|data):/i.test(raw)) continue;
    let u: URL;
    try { u = checkFetchUrl(new URL(raw, base).href); } catch { continue; }
    if (bareHost(u) !== bareHost(base) || STATIC_ASSET.test(u.pathname) || found.has(u.href)) continue;
    found.set(u.href, { url: u, score: USEFUL_PATH.test(u.pathname) ? 2 : 0 });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------------------------------

const ONBOARDING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function cleanOnboardingId(raw: unknown): string {
  if (typeof raw !== 'string' || !ONBOARDING_ID_RE.test(raw)) throw new Error('scrape-knowledge needs the onboardingId set by the workflow');
  return raw;
}

class PageTimeout extends Error {}
interface QueueItem { url: URL; seed: boolean; follow: boolean; score: number; seq: number }
const better = (a: QueueItem, b: QueueItem): boolean => (a.seed !== b.seed ? a.seed : a.score !== b.score ? a.score > b.score : a.seq < b.seq);

function takeNext(queue: QueueItem[]): QueueItem {
  let best = 0;
  for (let i = 1; i < queue.length; i++) if (better(queue[i]!, queue[best]!)) best = i;
  return queue.splice(best, 1)[0]!;
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function factId(onboardingId: string, c: KnowledgeCandidate): string {
  return `f_${createHash('sha256').update(`${onboardingId}\n${c.source}\n${c.text.toLowerCase()}`).digest('hex').slice(0, 16)}`;
}

/** One candidate per distinct text across all pages (first page wins), then the same per-kind caps as a single page. */
function mergeCandidates(all: KnowledgeCandidate[]): KnowledgeCandidate[] {
  const seen = new Set<string>();
  const count = { flagged: 0, price: 0, hours: 0, info: 0 };
  const out: KnowledgeCandidate[] = [];
  for (const c of all) {
    const key = candidateKey(c.text);
    const bucket = c.flags.length ? 'flagged' : c.kind;
    if (!key || seen.has(key) || count[bucket] >= CANDIDATE_CAPS[bucket]) continue;
    seen.add(key); count[bucket]++; out.push(c);
  }
  return out;
}

export async function scrapeKnowledge(input: ScrapeInput, deps: ScrapeDeps): Promise<ScrapeResult> {
  const onboardingId = cleanOnboardingId(input.onboardingId);
  const tenantId = asTenantId(typeof input.tenantId === 'string' ? input.tenantId : '');
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const skipped: Partial<Record<SkipReason, number>> = {};
  const skip = (reason: SkipReason, url?: string, n = 1): void => {
    skipped[reason] = (skipped[reason] ?? 0) + n;
    log({ level: 'info', step: 'scrape-knowledge', onboardingId, reason, ...(url ? { url: url.slice(0, 200) } : {}), ...(n > 1 ? { count: n } : {}) });
  };

  let bytesUsed = 0;
  const bytesLeft = () => limits.maxTotalBytes - bytesUsed;
  /** Counts what was read against the total, whatever the fetcher says it read; anything over `cap` is dropped. */
  const take = (body: unknown, cap: number): { text: string; bytes: number } => {
    const text = typeof body === 'string' ? body : '';
    const buf = Buffer.from(text, 'utf8');
    const cut = buf.length > cap ? buf.subarray(0, cap) : buf;
    bytesUsed += cut.length;
    return { text: cut === buf ? text : cut.toString('utf8'), bytes: cut.length };
  };

  const timed = async (url: string, maxBytes: number): Promise<FetchedPage> => {
    const ms = Math.max(1, Math.min(limits.pageTimeoutMs, limits.deadlineMs - elapsed()));
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new PageTimeout()); }, ms); });
    try { return await Promise.race([deps.fetchPage(url, { signal: ctl.signal, maxBytes }), timeout]); } finally { clearTimeout(timer); }
  };

  // robots.txt, once per site. Unreadable for a server reason = assume "no" (RFC 9309); missing (4xx) = allowed.
  const robotsCache = new Map<string, Promise<RobotsRules | 'unavailable'>>();
  async function loadRobots(origin: string): Promise<RobotsRules | 'unavailable'> {
    let url = new URL('/robots.txt', origin);
    for (let hop = 0; hop <= 5; hop++) {
      const cap = Math.min(limits.maxRobotsBytes, bytesLeft());
      if (elapsed() >= limits.deadlineMs || cap < MIN_USEFUL_BYTES) return 'unavailable';
      let res: FetchedPage;
      try { res = await timed(url.href, cap); } catch { return 'unavailable'; }
      const { text, bytes } = take(res.body, cap);
      if (res.status >= 300 && res.status < 400 && res.location) {
        try { url = checkFetchUrl(new URL(res.location, url).href); } catch { return 'unavailable'; }
        continue;
      }
      if (res.status >= 200 && res.status < 300) return bytes >= cap ? 'unavailable' : parseRobots(text); // cut off: do not guess the rest
      return res.status >= 400 && res.status < 500 && res.status !== 429 ? parseRobots('') : 'unavailable';
    }
    return 'unavailable';
  }
  const robotsFor = (u: URL) => {
    let p = robotsCache.get(u.origin);
    if (!p) { p = loadRobots(u.origin); robotsCache.set(u.origin, p); }
    return p;
  };

  // Where to start: the website, then up to three listings. Each must pass the address check before anything is requested.
  const seen = new Set<string>();
  const seeds: QueueItem[] = [];
  let seq = 0;
  const website = typeof input.website === 'string' ? input.website.trim() : '';
  if (!website) skip('no-website');
  const listings = Array.isArray(input.listings) ? input.listings.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, limits.maxListings) : [];
  for (const [i, raw] of [website, ...listings].entries()) {
    if (!raw) continue;
    try {
      const url = checkFetchUrl(raw);
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      seeds.push({ url, seed: true, follow: i === 0, score: 0, seq: seq++ }); // links are followed on the website only, not on listings
    } catch { skip('blocked-url', raw); }
  }

  const queue = [...seeds];
  const requested = new Set<string>();
  const found: KnowledgeCandidate[] = [];
  let pagesRequested = 0;
  let pagesFetched = 0;

  async function visit(item: QueueItem): Promise<void> {
    let url = item.url;
    const chain = new Set<string>([url.href]);
    for (let hops = 0; ; hops++) {
      if (requested.has(url.href)) return; // already read (a redirect landed on a page we have)
      const robots = await robotsFor(url);
      if (robots === 'unavailable') return skip('robots-unavailable', url.href);
      if (!robotsAllows(robots, url.pathname + url.search)) return skip('robots', url.href);
      if (pagesRequested >= limits.maxPages) return skip('page-limit', url.href);
      if (elapsed() >= limits.deadlineMs) return skip('deadline', url.href);
      const cap = Math.min(limits.maxPageBytes, bytesLeft());
      if (cap < MIN_USEFUL_BYTES) return skip('byte-budget', url.href);

      pagesRequested++;
      requested.add(url.href);
      let res: FetchedPage;
      try { res = await timed(url.href, cap); } catch (err) {
        return skip(err instanceof PageTimeout ? 'timeout' : err instanceof FetchBlockedError ? 'blocked-url' : 'fetch-error', url.href);
      }
      const { text } = take(res.body, cap);

      if (res.status >= 300 && res.status < 400 && res.location) {
        if (hops >= limits.maxRedirects) return skip('redirect-limit', url.href);
        let next: URL;
        try { next = new URL(res.location, url); } catch { return skip('fetch-error', url.href); }
        try { next = checkFetchUrl(next.href); } catch { return skip('blocked-url', url.href); }
        if (chain.has(next.href)) return skip('redirect-limit', url.href); // a loop
        chain.add(next.href);
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) return skip('http-error', url.href);
      if (!isPageContentType(res.contentType)) return skip('not-html', url.href);

      pagesFetched++;
      const plain = mediaType(res.contentType) === 'text/plain';
      found.push(...toCandidates(plain ? `<pre>${escapeText(text)}</pre>` : text, url.href));
      if (item.follow && !plain && pagesRequested < limits.maxPages) {
        for (const link of extractLinks(text, url)) {
          if (seen.size >= limits.maxQueue) break;
          if (seen.has(link.url.href)) continue;
          seen.add(link.url.href);
          queue.push({ url: link.url, seed: false, follow: true, score: link.score, seq: seq++ });
        }
      }
      return;
    }
  }

  while (queue.length) {
    const item = takeNext(queue);
    if (elapsed() >= limits.deadlineMs) { skip('deadline', undefined, queue.length + 1); break; }
    if (pagesRequested >= limits.maxPages) { skip('page-limit', undefined, queue.length + 1); break; }
    if (bytesLeft() < MIN_USEFUL_BYTES) { skip('byte-budget', undefined, queue.length + 1); break; }
    await visit(item);
  }

  const scrapedAt = (deps.now ?? (() => new Date()))().toISOString();
  const candidates = mergeCandidates(found);
  const items: FactItem[] = candidates.map((c) => ({
    PK: keys.tenantPk(tenantId),
    SK: keys.factSk(factId(onboardingId, c)),
    text: c.text,
    source: c.source,
    verified: false,
    flaggedInstructionLike: c.flags.length > 0,
    flags: c.flags,
    kind: c.kind,
    ...(c.label ? { label: c.label } : {}),
    ...(c.amountCents !== undefined ? { amountCents: c.amountCents } : {}),
    ...(c.maxAmountCents !== undefined ? { maxAmountCents: c.maxAmountCents } : {}),
    onboardingId,
    scrapedAt,
  }));
  let stored = 0;
  for (let i = 0; i < items.length; i += 8) {
    const wrote = await Promise.all(items.slice(i, i + 8).map((it) => deps.facts.putIfAbsent(it)));
    stored += wrote.filter(Boolean).length;
  }
  return { pagesFetched, bytesRead: bytesUsed, candidates: candidates.length, flagged: candidates.filter((c) => c.flags.length > 0).length, stored, skipped };
}

// ---------------------------------------------------------------------------------------------------------------------
// DynamoDB and Step Functions entry
// ---------------------------------------------------------------------------------------------------------------------

/**
 * FACT#<fid> lives in the tenant's own partition. The write is conditional (never overwrites), and refuses anything
 * that is not an unverified FACT# item for a tenant: scraping can never write a verified fact.
 */
export function ddbFactStore(client: { send(cmd: any): Promise<any> }, table: string): FactStore {
  return {
    async putIfAbsent(item) {
      if (item.verified !== false || !/^TENANT#t_[a-z0-9]{8,40}$/.test(item.PK) || !item.SK.startsWith('FACT#')) throw new Error('scrape-knowledge writes only unverified FACT# items');
      try {
        await client.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  };
}

/**
 * Step Functions entry. The whole workflow state arrives as the event: onboardingId and tenantId (set server-side when
 * provisioning starts), plus `website` and `listings` from the saved basics (contracts/CHANGE_REQUESTS/D6-1.md).
 */
export async function handler(event: ScrapeInput): Promise<ScrapeResult> {
  cleanOnboardingId(event.onboardingId);
  asTenantId(typeof event.tenantId === 'string' ? event.tenantId : '');
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return scrapeKnowledge(event, { fetchPage: httpFetchPage(), facts: ddbFactStore(client, table) });
}
