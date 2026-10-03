import { describe, expect, it } from 'vitest';
import { createDynamoStore } from '../src/store.js';

const TID = 't_abcdefgh12';

type Cmd = { constructor: { name: string }; input: any };
function fakeDb(handler: (c: Cmd) => unknown) {
  const sent: Cmd[] = [];
  return { sent, db: { send: async (c: Cmd) => { sent.push(c); return handler(c); } } as never };
}

describe('dynamo store', () => {
  it('claims an event id per channel and target with a conditional write and a TTL', async () => {
    const { db, sent } = fakeDb(() => ({}));
    const store = createDynamoStore({ db, table: 'tbl', now: () => new Date('2026-10-02T12:00:00Z') });
    expect(await store.claim(TID, 'evt-1', 'telegram:42')).toBe(true);
    const put = sent[0]!.input;
    expect(put.TableName).toBe('tbl');
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(put.Item.PK).toBe(`TENANT#${TID}`);
    expect(put.Item.SK).toMatch(/^NOTIF#evt-1#telegram#[0-9a-f]{12}$/);
    expect(put.Item.ttl).toBeGreaterThan(Math.floor(Date.parse('2026-10-02T12:00:00Z') / 1000));
  });

  it('says false when the claim already exists, and rethrows real errors', async () => {
    const dup = fakeDb(() => { throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }); });
    expect(await createDynamoStore({ db: dup.db, table: 't' }).claim(TID, 'e', 'email:a@b.c')).toBe(false);
    const boom = fakeDb(() => { throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }); });
    await expect(createDynamoStore({ db: boom.db, table: 't' }).claim(TID, 'e', 'email:a@b.c')).rejects.toThrow('throttled');
  });

  it('keeps tenant data and ids with # in them out of the key', async () => {
    const { db, sent } = fakeDb(() => ({}));
    await createDynamoStore({ db, table: 't' }).claim(TID, 'evt#1', 'push:https://x');
    expect(sent[0]!.input.Item.SK.split('#').length).toBe(4); // NOTIF, id, channel, hash
  });

  it('builds owner targets from MEMBER items and push subscriptions', async () => {
    const { db } = fakeDb((c) => {
      const prefix = c.input.ExpressionAttributeValues[':sk'];
      if (prefix === 'MEMBER#') return { Items: [
        { SK: 'MEMBER#a', role: 'owner', email: 'Kemi@Example.com', phone: '+15552223333', identities: [{ channel: 'telegram', id: '42' }, { channel: 'whatsapp', id: '9' }] },
        { SK: 'MEMBER#b', role: 'staff', email: 'staff@example.com', identities: [{ channel: 'telegram', id: '77' }] },
        { SK: 'MEMBER#c', role: 'owner', email: 'kemi@example.com' },
      ] };
      if (prefix === 'NOTIFY#PUSH#') return { Items: [{ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }] };
      return { Items: [] };
    });
    const t = await createDynamoStore({ db, table: 't' }).getTargets(TID);
    expect(t.telegramChatIds).toEqual(['42']);
    expect(t.emails).toEqual(['kemi@example.com']);
    expect(t.phone).toBe('+15552223333');
    expect(t.pushSubscriptions).toHaveLength(1);
  });

  it('reads prefs and tenant profile with safe defaults', async () => {
    const { db } = fakeDb(() => ({}));
    const store = createDynamoStore({ db, table: 't' });
    expect(await store.getPrefs(TID)).toEqual({});
    expect(await store.getTenant(TID)).toEqual({ name: 'your business', timezone: 'UTC' });
  });

  it('falls back to UTC for a timezone Intl does not know', async () => {
    const { db } = fakeDb(() => ({ Item: { name: 'Kemi Cuts', timezone: 'Mars/Olympus' } }));
    expect(await createDynamoStore({ db, table: 't' }).getTenant(TID)).toEqual({ name: 'Kemi Cuts', timezone: 'UTC' });
  });
});
