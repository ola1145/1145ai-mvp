/** Key builders for table t1145. See contracts/dynamodb/keys.md. */
const seg = (v: string, name: string): string => {
  if (!v || v.includes('#')) throw new Error(`invalid key segment: ${name}`);
  return v;
};

export const keys = {
  tenantPk: (tid: string) => `TENANT#${seg(tid, 'tid')}`,
  profileSk: () => 'PROFILE',
  hoursSk: () => 'HOURS',
  serviceSk: (sid: string) => `SERVICE#${seg(sid, 'sid')}`,
  factSk: (fid: string) => `FACT#${seg(fid, 'fid')}`,
  customerSk: (cid: string) => `CUSTOMER#${seg(cid, 'cid')}`,
  bookingSk: (startIso: string, bid: string) => `BOOKING#${seg(startIso, 'start')}#${seg(bid, 'bid')}`,
  bookingGsi1: (tid: string, bid: string) => ({ GSI1PK: `TENANT#${seg(tid, 'tid')}#BID`, GSI1SK: seg(bid, 'bid') }),
  slotSk: (resource: string, slotIso: string) => `SLOT#${seg(resource, 'resource')}#${seg(slotIso, 'slot')}`,
  convSk: (startIso: string, convId: string) => `CONV#${seg(startIso, 'start')}#${seg(convId, 'conv')}`,
  idempotencySk: (key: string) => `IDEMP#${seg(key, 'idempotency')}`,
  usageSk: (yyyymm: string) => `USAGE#${seg(yyyymm, 'month')}`,
  memberSk: (sub: string) => `MEMBER#${seg(sub, 'sub')}`,
  // Route items: readable by the resolver role only.
  numberRoutePk: (e164: string) => `NUMBER#${seg(e164, 'e164')}`,
  identityRoutePk: (channel: string, channelUserId: string) =>
    `IDENTITY#${seg(channel, 'channel')}#${seg(channelUserId, 'channelUserId')}`,
  engineAgentRoutePk: (engine: string, agentId: string) => `ENGINEAGENT#${seg(engine, 'engine')}#${seg(agentId, 'agentId')}`,
  signupPk: (tokenHash: string) => `SIGNUP#${seg(tokenHash, 'tokenHash')}`,
  routeSk: () => 'ROUTE',
} as const;
