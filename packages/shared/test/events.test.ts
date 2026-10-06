/** Event contract (owner: C0): packages/shared EventType <-> contracts/events/events.schema.json. */
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, makeEvent, type EventType } from '../src/events.js';
import { asTenantId } from '../src/tenant-context.js';
import { pointer, validate, type RefResolver } from './support/schema-lite.js';
import { eventsSchema, isObj, type Obj } from './support/contracts.js';

const schema = eventsSchema();
const defs = (isObj(schema.$defs) ? schema.$defs : {}) as Obj;
const local: RefResolver = (ref, doc) => ({ schema: pointer(schema, ref), doc });

describe('event types', () => {
  it('EVENT_TYPES has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('the envelope enum lists exactly the EventTypes in packages/shared', () => {
    const props = schema.properties as Obj;
    const enumList = (props.type as Obj).enum as string[];
    expect([...enumList].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each([...EVENT_TYPES])('%s has a $defs entry', (t) => {
    expect(isObj(defs[t]), `missing $defs["${t}"]`).toBe(true);
    expect((defs[t] as Obj).type).toBe('object');
  });

  it('every $defs entry is a known EventType', () => {
    expect(Object.keys(defs).filter((k) => !(EVENT_TYPES as readonly string[]).includes(k))).toEqual([]);
  });

  it.each([...EVENT_TYPES])('%s has data examples that match its $defs entry', (t) => {
    const def = defs[t] as Obj | undefined;
    const examples = Array.isArray(def?.examples) ? (def!.examples as unknown[]) : [];
    expect(examples.length, `$defs["${t}"].examples is empty`).toBeGreaterThan(0);
    for (const ex of examples) expect(validate(def, ex, local, 'events')).toEqual([]);
  });

  it.each([...EVENT_TYPES])('makeEvent(%s) produces a valid envelope', (t: EventType) => {
    const data = ((defs[t] as Obj | undefined)?.examples as Obj[] | undefined)?.[0] ?? {};
    const evt = makeEvent(t, { tenantId: asTenantId('t_tenanta01'), correlationId: 'call-1' }, data, new Date('2026-10-03T15:00:00Z'));
    expect(validate(schema, evt, local, 'events')).toEqual([]);
    expect(validate(defs[t], evt.data, local, 'events')).toEqual([]);
  });
});
