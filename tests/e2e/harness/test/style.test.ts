import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCapturedTurns } from '../style.ts';
import type { Turn } from '../ports.ts';

const t = (surface: Turn['surface'], conversationId: string, role: Turn['role'], text: string): Turn => ({ surface, conversationId, role, text });

test('clean chat and voice turns pass', () => {
  const r = checkCapturedTurns([
    t('phone', 'call-1', 'agent', "Hi, this is Ava at Kemi Cuts. I'm the AI receptionist and calls are recorded. What can I do for you?"),
    t('phone', 'call-1', 'user', 'A haircut tomorrow.'),
    t('phone', 'call-1', 'agent', 'Sure, what time works?'),
    t('telegram', 'tg', 'agent', 'New booking: Tunde, haircut, tomorrow at 3.'),
  ]);
  assert.equal(r.ok, true, r.failures.join('\n'));
  assert.equal(r.turns.length, 3);
});

test('user turns are not style-checked', () => {
  const r = checkCapturedTurns([t('owner-chat', 'oc', 'user', 'I would be happy to assist you, kindly proceed'), t('owner-chat', 'oc', 'agent', 'Nice, what are your hours?')]);
  assert.equal(r.ok, true);
  assert.equal(r.turns.length, 1);
});

test('robotic agent phrasing is an error', () => {
  const r = checkCapturedTurns([t('owner-chat', 'oc', 'agent', 'I apologize, sorry for the inconvenience. Thank you for your patience.')]);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /inconvenience/.test(f)));
});

test('voice limits apply to phone, not to chat', () => {
  const long = Array.from({ length: 60 }, () => 'word').join(' ');
  assert.equal(checkCapturedTurns([t('owner-chat', 'oc', 'agent', long + '.')]).ok, true);
  assert.equal(checkCapturedTurns([t('phone', 'c', 'agent', `AI recorded ${long}.`)]).ok, false);
});

test('repetition is detected within a conversation but not across conversations', () => {
  const same = 'Got it, one sec.';
  assert.equal(checkCapturedTurns([t('owner-chat', 'a', 'agent', same), t('owner-chat', 'b', 'agent', same)]).ok, true);
  assert.equal(checkCapturedTurns([t('owner-chat', 'a', 'agent', same), t('owner-chat', 'a', 'agent', same)]).ok, false);
});

test('phone calls require the AI and recording disclosure on the first agent turn', () => {
  const r = checkCapturedTurns([t('phone', 'c', 'agent', 'Hi, Kemi Cuts, what can I do for you?')]);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /disclosure/.test(f)));
});
