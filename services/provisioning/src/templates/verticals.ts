/**
 * Vertical vocabulary. Each trade gets its own words, its usual questions and a short sample call that sets the tone.
 * Rules never live here: every vertical shares the same ground rules in the template (see v0-1-0.ts).
 *
 * `greeting.sayToCaller` is the first thing a caller hears ({agentName} and {businessName} are filled at render time).
 * The `sayToCaller` key is deliberate: scripts/ci/check-style.ts picks it up and gates it on conversation-style.
 */
import { detectInstructionLike } from '../lib/sanitize.js';

export type VerticalId ='salon' | 'auto' | 'home' | 'general';

export interface SampleTurn { role: 'caller' | 'agent'; text: string }

export interface VerticalVocab {
  id: VerticalId;
  /** What to call the business when the owner's own description is missing or unusable. */
  kind: string;
  /** Noun added to the owner's own words when they describe a trade, not a place ("plumbing" -> "plumbing company"). */
  kindNoun: string;
  customers: string;
  booking: string;
  usualAsks: string;
  toBook: string;
  urgent: string;
  greeting: { sayToCaller: string };
  /** Mid-call example, made-up names and times. Shown to the model for tone only. */
  sampleCall: SampleTurn[];
  sampleCallerName: string;
}

export const VERTICALS: Record<VerticalId, VerticalVocab> = {
  salon: {
    id: 'salon',
    kind: 'salon',
    kindNoun: 'salon',
    customers: 'clients',
    booking: 'appointment',
    usualAsks: 'booking a cut, color, trim or shave, moving or cancelling an appointment, prices, how long things take, and whether their stylist or barber is in that day',
    toBook: 'the service, a day and time, their name, and which stylist or barber they like to see, if they have one',
    urgent: 'someone running late for an appointment that starts soon',
    greeting: { sayToCaller: "Hi, this is {agentName} at {businessName}. I'm the AI receptionist and calls are recorded. What can I do for you?" },
    sampleCall: [
      { role: 'caller', text: 'Hey, do you have anything for a fade this Saturday?' },
      { role: 'agent', text: "Let me look. I've got ten or eleven-thirty on Saturday. Either of those work?" },
      { role: 'caller', text: "Ten works. It's Marcus." },
      { role: 'agent', text: "Got it, Marcus. You're all set for a fade Saturday at ten. See you then!" },
    ],
    sampleCallerName: 'Marcus',
  },
  auto: {
    id: 'auto',
    kind: 'auto repair shop',
    kindNoun: 'shop',
    customers: 'customers',
    booking: 'appointment or drop-off',
    usualAsks: "getting a car looked at, warning lights and strange noises, oil changes, brakes and tires, whether their car is ready, and what a repair might cost",
    toBook: "the year, make and model, what's going on with the car, whether they'll drop it off or wait, a day and time, and their name",
    urgent: "a car that's broken down or doesn't feel safe to drive",
    greeting: { sayToCaller: "Hi, this is {agentName} at {businessName}. I'm the AI receptionist and calls are recorded. What can I do for you?" },
    sampleCall: [
      { role: 'caller', text: 'My check engine light came on this morning. Can you guys look at it?' },
      { role: 'agent', text: "Sure, we can take a look. What's the year, make and model?" },
      { role: 'caller', text: "It's a 2015 Honda Civic." },
      { role: 'agent', text: 'Thanks. I can fit you in tomorrow at eight or Thursday at nine. Which is better?' },
      { role: 'caller', text: "Tomorrow at eight. I'll drop it off. Name's Dana." },
      { role: 'agent', text: "Perfect, Dana. You're down for a drop-off tomorrow at eight." },
    ],
    sampleCallerName: 'Dana',
  },
  home: {
    id: 'home',
    kind: 'home services company',
    kindNoun: 'company',
    customers: 'customers',
    booking: 'visit',
    usualAsks: 'leaks, breakdowns and repairs, getting a quote, when a tech can come out, and whether you cover their area',
    toBook: "what's going on, the service address, a day and arrival window, their name, and the best number to reach them",
    urgent: 'water actively leaking, no heat or no AC in extreme weather, a gas smell, a burning smell, or sparks',
    greeting: { sayToCaller: "Hi, this is {agentName} at {businessName}. I'm the AI receptionist and calls are recorded. How can I help?" },
    sampleCall: [
      { role: 'caller', text: "Hi, my kitchen sink's been leaking under the cabinet." },
      { role: 'agent', text: 'Oh no, okay. Is it a slow drip, or is water pooling on the floor?' },
      { role: 'caller', text: 'Just a slow drip. I put a bucket under it.' },
      { role: 'agent', text: 'Good call on the bucket. I can get a tech out tomorrow between eight and ten, or Friday afternoon. Which is easier?' },
      { role: 'caller', text: "Tomorrow morning. I'm Priya, at 412 Elm Street." },
      { role: 'agent', text: "Got it, Priya. You're set for tomorrow between eight and ten at 412 Elm." },
    ],
    sampleCallerName: 'Priya',
  },
  general: {
    id: 'general',
    kind: 'local business',
    kindNoun: 'business',
    customers: 'customers',
    booking: 'appointment',
    usualAsks: 'booking, moving or cancelling appointments, hours, prices, and general questions about the business',
    toBook: 'what they need, a day and time, and their name',
    urgent: "anything that can't wait until the team calls back",
    greeting: { sayToCaller: "Hi, this is {agentName} at {businessName}. I'm the AI receptionist and calls are recorded. What can I do for you?" },
    sampleCall: [
      { role: 'caller', text: 'Hi, are you open on Saturday?' },
      { role: 'agent', text: 'We are, ten to four. Want me to book you in?' },
      { role: 'caller', text: "Yeah, around eleven if you can. It's Lee." },
      { role: 'agent', text: "Eleven's open. You're all set for Saturday at eleven, Lee. See you then!" },
    ],
    sampleCallerName: 'Lee',
  },
};

const PATTERNS: Array<[VerticalId, RegExp]> = [
  ['salon', /\b(?:barber\w*|salons?|hair\w*|nails?|beauty|spa|lash\w*|brows?|braid\w*|stylists?|cuts?|wax\w*|esthetic\w*)\b/i],
  ['auto', /\b(?:auto\w*|cars?|mechanic\w*|tires?|tyres?|brakes?|oil change|body shop|collision|transmission|smog|vehicles?|garage)\b/i],
  ['home', /\b(?:plumb\w*|hvac|heating|cooling|air conditioning|electric\w*|clean\w*|maids?|landscap\w*|lawn\w*|handyman|roof\w*|pest|pools?|garage doors?|locksmith\w*|painting|painters?|carpet\w*|appliance\w*|home services?|remodel\w*|pressure washing|gutters?)\b/i],
];

const PLACE_NOUN = /\b(?:shop|barbershop|salon|studio|spa|parlou?r|lounge|bar|garage|cent(?:er|re)|company|co|services?|store|bakery|restaurant|cafe|gym|agency|business|contractors?|plumbers?|electricians?|cleaners|mechanics?)$/i;

/** "a"/"an" by sound: "an HVAC company", "an auto shop", "a plumbing company". */
export function withArticle(phrase: string): string {
  const first = phrase.split(' ')[0] ?? '';
  const an = /^[A-Z]{2,}$/.test(first) ? /^[AEFHILMNORSX]/.test(first) : /^[aeiou]/i.test(first);
  return `${an ? 'an' : 'a'} ${phrase}`;
}

/**
 * The owner's own words for the business, as a noun phrase with an article ("an auto repair shop", "a barbershop").
 * Owner free text: one short plain phrase or nothing; anything odd falls back to the vertical's neutral noun.
 */
export function describeBusiness(ownerType: string | undefined, vertical: VerticalId): string {
  const vocab = VERTICALS[vertical];
  const raw = String(ownerType ?? '').replace(/\s+/g, ' ').trim();
  const ok = raw.length <= 40 && /^[A-Za-z][A-Za-z &'-]*$/.test(raw) && raw.split(' ').length <= 4 && detectInstructionLike(raw).length === 0;
  if (!ok) return withArticle(vocab.kind);
  let phrase = raw.split(' ').map((w) => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(' ');
  if (/^barbers?$/i.test(phrase)) phrase = 'barbershop';
  return withArticle(PLACE_NOUN.test(phrase) ? phrase : `${phrase} ${vocab.kindNoun}`);
}

/** Owner's free-text business type -> vertical. Unknown trades get the neutral vocabulary. */
export function verticalFor(businessType: string | undefined): VerticalId {
  const t = (businessType ?? '').trim();
  if (/\bgarage doors?\b/i.test(t)) return 'home';
  for (const [id, re] of PATTERNS) if (re.test(t)) return id;
  return 'general';
}
