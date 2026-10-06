import { describe, expect, it } from 'vitest';
import { checkConversation, checkReply, naturalnessScore } from '../src/index.js';

const rules = (text: string, channel: 'voice' | 'chat' = 'voice', extra = {}) => checkReply(text, { channel, ...extra }).map((i) => i.rule);

describe('robotic phrasing', () => {
  it('flags call-center scripts', () => {
    expect(rules('I apologize for any inconvenience. Your call is important to us.')).toEqual(expect.arrayContaining(['inconvenience', 'call-center']));
    expect(rules('I understand your frustration.')).toContain('scripted-empathy');
    expect(rules('As an AI, I cannot do that.')).toContain('ai-self-talk');
  });
  it('allows the required disclosure on the first turn', () => {
    const first = "Hi, this is Ava at Kemi Cuts. I'm the AI receptionist, and calls are recorded. What can I do for you?";
    expect(checkReply(first, { channel: 'voice', isFirstTurn: true }).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('passes a natural booking reply', () => {
    expect(checkReply("Got it, Tunde. I've got you down for tomorrow at three. See you then!", { channel: 'voice' })).toEqual([]);
  });
});

describe('voice constraints', () => {
  it('rejects things that cannot be spoken', () => {
    expect(rules('Your slot is 2026-10-06T20:00. Book at https://x.com')).toEqual(expect.arrayContaining(['voice-iso-date', 'voice-url']));
    expect(rules('Options:\n- 3 PM\n- 4 PM')).toContain('voice-formatting');
  });
  it('keeps turns short', () => {
    const long = Array.from({ length: 50 }, () => 'word').join(' ') + '.';
    expect(rules(long)).toContain('voice-length');
  });
});

describe('more robotic patterns', () => {
  it('flags tool narration and system talk', () => {
    expect(rules('I am now accessing the scheduling system to retrieve your appointment.')).toContain('tool-narration');
    expect(rules('Let me query the database for that.')).toContain('tool-narration');
    expect(rules('One sec, checking the calendar.')).not.toContain('tool-narration');
  });
  it('flags stiff formal phrasing', () => {
    expect(rules('Thank you for contacting Kemi Cuts.')).toContain('call-center');
    expect(rules('Please be informed that we are closed.')).toContain('call-center');
    expect(rules('I am unable to assist with that request.')).toContain('stiff-refusal');
    expect(rules('I apologize.')).toContain('formal-apology');
    expect(rules("Sorry, I missed that, what day?")).toEqual([]);
  });
  it('flags "happy to help you" variants and virtual-assistant self-talk', () => {
    expect(rules("I'd be happy to help you with that!")).toContain('assist-filler');
    expect(rules('As a virtual assistant I cannot do that.')).toContain('ai-self-talk');
  });
  it('does not flag natural lines', () => {
    for (const ok of ["Sure, when works for you?", "Ugh, sorry about that. Let's get it sorted.", "You're all set for tomorrow at three. See you then!", "I can't cancel that one without a code, but I can take a message."]) {
      expect(rules(ok)).toEqual([]);
    }
  });
  it('requires the AI and recording disclosure on a voice first turn when asked to', () => {
    const bare = 'Hi, this is Ava at Kemi Cuts. What can I do for you?';
    expect(rules(bare, 'voice', { isFirstTurn: true, requireDisclosure: true })).toContain('missing-disclosure');
    expect(rules("Hi, this is Ava at Kemi Cuts. I'm the AI receptionist and calls are recorded. What can I do for you?", 'voice', { isFirstTurn: true, requireDisclosure: true })).not.toContain('missing-disclosure');
    expect(rules('Hi, I am the AI receptionist. What can I do for you?', 'voice', { isFirstTurn: true, requireDisclosure: true })).toContain('missing-disclosure');
    expect(rules(bare, 'voice', { isFirstTurn: false, requireDisclosure: true })).not.toContain('missing-disclosure');
  });
  it('flags spoken digits and codes that should be said like people say them', () => {
    expect(rules('Your confirmation is A7F-29K-1B3-XQ9.')).toContain('voice-code');
    expect(rules('Call us at 214-555-0123.')).not.toContain('voice-code');
  });
});

describe('conversation-level repetition', () => {
  it('catches repeated openers, repeated "anything else", and name overuse', () => {
    const turns = [
      { role: 'agent' as const, text: 'Sure thing Ada, let me check.' },
      { role: 'user' as const, text: 'ok' },
      { role: 'agent' as const, text: 'Sure thing Ada, three works. Is there anything else I can help you with?' },
      { role: 'user' as const, text: 'no' },
      { role: 'agent' as const, text: 'Is there anything else I can help you with?' },
    ];
    const res = checkConversation(turns, 'voice', 'Ada');
    expect(res[1]!.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(['repeated-opener', 'name-overuse']));
    expect(res[2]!.issues.map((i) => i.rule)).toContain('anything-else-repeat');
    expect(naturalnessScore(res[2]!.issues)).toBeLessThan(85);
  });
});
