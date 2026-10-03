/**
 * The Gate scenario (docs/03-implementation-plan.md) as an automated test, run against the in-memory fake platform.
 * The same runGate() runs against the deployed dev stack from gate.live.test.ts. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, GATE_STEP_IDS } from '../harness/gate.ts';
import { createFakePlatform, type Fault } from '../harness/fakes/fake-platform.ts';

const NOW = new Date('2026-10-03T15:00:00Z');
const FAST = { eventMs: 5, telegramMs: 5, provisionMs: 20, pollMs: 2 };

async function gateWith(fault?: Fault) {
  const fake = createFakePlatform({ fault, now: NOW });
  const report = await runGate(fake.ports, { now: NOW, timeouts: FAST });
  return { fake, report };
}
const failedIds = (r: { steps: Array<{ id: string; status: string }> }) => r.steps.filter((s) => s.status === 'fail').map((s) => s.id);

test('Gate: friend link to copilot to recorded call passes end to end', async () => {
  const { report } = await gateWith();
  assert.deepEqual(report.steps.map((s) => s.id), [...GATE_STEP_IDS]);
  assert.deepEqual(report.steps.filter((s) => s.status !== 'pass'), [], JSON.stringify(report.steps.filter((s) => s.status !== 'pass')));
  assert.equal(report.style.failures.length, 0, report.style.failures.join('\n'));
  assert.equal(report.ok, true);
});

test('Gate: every surface in the plan is exercised (web chat, Telegram, two phone calls)', async () => {
  const { report } = await gateWith();
  const surfaces = new Set(report.turns.map((t) => t.surface));
  for (const s of ['owner-chat', 'customer-chat', 'telegram', 'phone'] as const) assert.ok(surfaces.has(s), `missing ${s}`);
  const calls = new Set(report.turns.filter((t) => t.surface === 'phone').map((t) => t.conversationId));
  assert.equal(calls.size, 2, 'smoke call plus the booking call');
});

test('Gate: conversation-style runs on every agent turn that was captured', async () => {
  const { report } = await gateWith();
  const agentTurns = report.turns.filter((t) => t.role === 'agent');
  assert.ok(agentTurns.length >= 12, `only ${agentTurns.length} agent turns captured`);
  assert.equal(report.style.turns.length, agentTurns.length);
  for (const t of report.style.turns) assert.ok(t.score >= 85, `${t.text} scored ${t.score}`);
});

test('Gate: the booking is recorded with the right customer for tomorrow in the tenant timezone', async () => {
  const { fake, report } = await gateWith();
  assert.equal(report.ok, true);
  const tenant = fake.state.tenant!;
  const bookings = await fake.ports.platform.listBookings(tenant.tenantId);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0]!.customerName, 'Tunde');
  assert.match(bookings[0]!.startsAt, /^2026-10-04T/);
});

test('Gate: robotic phone greeting fails the run through the style gate, not just a step', async () => {
  const { report } = await gateWith('robotic-greeting');
  assert.equal(report.ok, false);
  assert.ok(report.style.failures.some((f) => /call-center|assist-filler/.test(f)), report.style.failures.join('\n'));
});

test('Gate: robotic Telegram notification fails the style gate', async () => {
  const { report } = await gateWith('robotic-notification');
  assert.equal(report.ok, false);
  assert.ok(report.style.failures.length > 0);
});

test('Gate: a first spoken turn without the AI/recording disclosure fails', async () => {
  const { report } = await gateWith('no-disclosure');
  assert.equal(report.ok, false);
  assert.ok(report.style.failures.some((f) => /disclosure/.test(f)));
});

test('Gate: a call that never books is reported at the booking step, later steps are skipped, style still runs', async () => {
  const { report } = await gateWith('no-booking');
  assert.equal(report.ok, false);
  assert.deepEqual(failedIds(report), ['customer-call-books']);
  const idx = GATE_STEP_IDS.indexOf('customer-call-books');
  for (const s of report.steps.slice(idx + 1)) assert.equal(s.status, 'skipped', s.id);
  assert.ok(report.turns.some((t) => t.surface === 'phone'), 'turns captured before the failure are still style-checked');
});

test('Gate: no Telegram notification fails the Telegram step', async () => {
  const { report } = await gateWith('no-telegram');
  assert.equal(report.ok, false);
  assert.deepEqual(failedIds(report), ['owner-telegram-notified']);
});

test('Gate: the number is never bought, the run stops at provisioning', async () => {
  const { report } = await gateWith('number-never-bought');
  assert.equal(report.ok, false);
  assert.deepEqual(failedIds(report), ['number-bought']);
});

test('Gate: a call recorded under a different tenant than the DID owner fails (tenant identity comes from the number)', async () => {
  const { report } = await gateWith('wrong-tenant');
  assert.equal(report.ok, false);
  assert.ok(failedIds(report).includes('customer-call-books'));
});

test('Gate: unmasked phone numbers in realtime events fail', async () => {
  const { report } = await gateWith('unmasked-phone-in-live-event');
  assert.equal(report.ok, false);
  assert.deepEqual(failedIds(report), ['owner-sees-it-live']);
});

test('Gate: missing usage record fails the recording step', async () => {
  const { report } = await gateWith('no-usage');
  assert.equal(report.ok, false);
  assert.deepEqual(failedIds(report), ['call-recorded']);
});

test('Gate: a thrown adapter error is a failed step with the message, not a crashed run', async () => {
  const fake = createFakePlatform({ now: NOW });
  fake.ports.referral.follow = async () => { throw new Error('connect ECONNREFUSED'); };
  const report = await runGate(fake.ports, { now: NOW, timeouts: FAST });
  assert.equal(report.ok, false);
  assert.equal(report.steps[0]!.status, 'fail');
  assert.match(report.steps[0]!.detail ?? '', /ECONNREFUSED/);
});
