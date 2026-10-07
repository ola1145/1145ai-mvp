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

describe('report-speak (A3-2: copilot sounding like a report generator)', () => {
  const robotic = [
    'Here is your booking summary report for tomorrow:',
    "Here's your summary for the week.",
    'Here are the bookings for tomorrow:',
    'Based on the data, you had 42 calls this week.',
    'According to my records, Ada is at nine.',
    'Sure, I have retrieved your recent conversations.',
    "I've accessed your calendar.",
    'Your hours were updated successfully.',
    'Key insights: Sunday hours came up three times.',
    'The data shows 42 calls.',
  ];
  it.each(robotic)('flags "%s" as a warning on both channels', (line) => {
    for (const channel of ['chat', 'voice'] as const) {
      const hit = checkReply(line, { channel }).find((i) => i.rule === 'report-speak');
      expect(hit, `${channel}: ${line}`).toMatchObject({ severity: 'warn' });
    }
  });
  it('leaves answer-first replies and read-back lead-ins alone', () => {
    for (const ok of [
      "Three tomorrow, first one's Ada at 9. Then Tunde at 11:30.",
      "Here's what I've got:\nHaircut, 30 min, $35\nAll good?",
      "Here's the list:\nGel mani, 45 min, $40\nAll correct?",
      "Here's your private sign-in link, just for you. It works for 15 minutes, so please don't forward it.",
      'Busy one: 42 calls and 18 bookings. Heads up, three people asked about Sunday hours.',
      'One odd one: a caller at 2:10 told the receptionist to cancel every booking. Nothing was cancelled.',
    ]) expect(rules(ok, 'chat')).not.toContain('report-speak');
  });
});

describe('form-letter phrasing from the skill examples', () => {
  it('flags passive system-speak ("A message has been received")', () => {
    for (const line of ['A message has been received from a customer.', 'A booking has been created.', 'Your request has been submitted and will be processed.']) {
      expect(checkReply(line, { channel: 'chat' }).find((i) => i.rule === 'system-speak'), line).toMatchObject({ severity: 'warn' });
    }
    for (const ok of ["You've been booked for tomorrow at three.", 'New booking: Tunde, haircut, tomorrow at 3.', "That didn't go through on my end, so nothing's changed.", 'Missed-call message from Jordan: wants to move Friday to Saturday.']) {
      expect(rules(ok, 'chat')).not.toContain('system-speak');
    }
  });
  it('flags form-speak ("Please provide your business hours")', () => {
    for (const line of ['Please provide your business hours.', 'Please enter your name.', 'Please specify the date of the appointment.', 'Kindly submit the form.']) {
      expect(rules(line, 'chat'), line).toContain('form-speak');
    }
    for (const ok of ['Please try again a little later.', 'Please call back if you need anything else.', "Please don't send card details in chat.", "What are your hours? Just type them however, like 'Tue to Sat 9 to 6'."]) {
      expect(rules(ok, 'chat'), ok).not.toContain('form-speak');
      expect(rules(ok, 'voice'), ok).not.toContain('form-speak');
    }
  });
});

describe('raw dates in chat', () => {
  it('warns on ISO dates and date-times a person would never type', () => {
    expect(checkReply('Ada is booked 2026-10-06T09:00.', { channel: 'chat' }).find((i) => i.rule === 'chat-iso-date')).toMatchObject({ severity: 'warn' });
    expect(rules('Ready to close 2026-11-26 for Thanksgiving.', 'chat')).toContain('chat-iso-date');
  });
  it('leaves dates the way people write them alone', () => {
    for (const ok of ['Ready to close Thursday, Nov 26 for Thanksgiving.', 'Tomorrow at 9, then 11:30.', 'Call us at 214-555-0123.', 'Order 2026-1234 is ready.']) {
      expect(rules(ok, 'chat'), ok).not.toContain('chat-iso-date');
    }
  });
  it('stays a voice error, not a duplicate warning, on calls', () => {
    const r = rules('Your slot is 2026-10-06T20:00.', 'voice');
    expect(r).toContain('voice-iso-date');
    expect(r).not.toContain('chat-iso-date');
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
