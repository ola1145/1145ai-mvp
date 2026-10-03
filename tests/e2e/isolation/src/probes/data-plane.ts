/**
 * Probe 2: assume the tenant data role directly with session tag tenant_id=A (bypassing the tool API entirely)
 * and try to reach tenant B's rows. ADR-0003: this must fail in IAM (dynamodb:LeadingKeys), not in app code.
 */
import { fail, pass, type Finding } from '../findings.js';
import type { DataPlanePort, DdbOp, DdbSession } from '../types.js';

export interface DataPlaneProbeConfig {
  a: { tenantId: string };
  b: { tenantId: string };
  table: string;
  /** An E.164 number that has a NUMBER# route item, and an identity key like "telegram#12345" (route items). */
  bNumber: string;
  bIdentity: string;
}

const S = (v: string) => ({ S: v });
const pk = (tid: string) => `TENANT#${tid}`;

export async function runDataPlaneProbes(port: DataPlanePort, cfg: DataPlaneProbeConfig): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [self, other, prefix] of [[cfg.a, cfg.b, 'ddb'], [cfg.b, cfg.a, 'ddb[B->A]']] as const) {
    out.push(...(await probeDirection(port, cfg, self.tenantId, other.tenantId, prefix)));
  }
  return out;
}

async function probeDirection(port: DataPlanePort, cfg: DataPlaneProbeConfig, self: string, other: string, p: string): Promise<Finding[]> {
  const out: Finding[] = [];
  let session: DdbSession;
  try {
    session = await port.assumeRole({ tenant_id: self });
  } catch (e) {
    return [fail(`${p}:assume-role`, `AssumeRole with tag tenant_id=${self} failed: ${e instanceof Error ? e.message : String(e)}`)];
  }
  const T = cfg.table;
  const query = (partition: string, extra: Record<string, unknown> = {}) => ({
    TableName: T, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': S(partition) }, Limit: 5, ...extra,
  });

  // Control: the session works and sees its own data. Without it, "AccessDenied" could mean a broken role.
  const own = await session.call('Query', query(pk(self)));
  const ownCount = own.ok ? ((own.data as { Items?: unknown[] }).Items ?? []).length : 0;
  if (!own.ok) { out.push(fail(`${p}:control-own-partition`, `session for ${self} cannot read its own partition: ${own.errorType} ${own.message}`)); return out; }
  if (ownCount === 0) { out.push(fail(`${p}:control-own-partition`, `own partition ${pk(self)} returned no items; seed the tenant so a denial is distinguishable from an empty table`)); return out; }
  out.push(pass(`${p}:control-own-partition`, `${ownCount} item(s)`));

  const mustDeny: Array<[string, DdbOp, Record<string, unknown>]> = [
    ['query-foreign-partition', 'Query', query(pk(other))],
    ['get-foreign-item', 'GetItem', { TableName: T, Key: { PK: S(pk(other)), SK: S('PROFILE') } }],
    ['query-foreign-gsi1', 'Query', { ...query(`${pk(other)}#BID`), IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk' }],
    ['scan-table', 'Scan', { TableName: T, Limit: 5 }],
    ['batch-get-mixed', 'BatchGetItem', { RequestItems: { [T]: { Keys: [{ PK: S(pk(self)), SK: S('PROFILE') }, { PK: S(pk(other)), SK: S('PROFILE') }] } } }],
    ['put-foreign-item', 'PutItem', { TableName: T, Item: { PK: S(pk(other)), SK: S('ISOLATION#probe'), note: S('written by the isolation probe; must never exist') }, ConditionExpression: 'attribute_not_exists(PK)' }],
    // Route items belong to the resolver role only (contracts/dynamodb/keys.md).
    ['get-route-number', 'GetItem', { TableName: T, Key: { PK: S(`NUMBER#${cfg.bNumber}`), SK: S('ROUTE') } }],
    ['get-route-identity', 'GetItem', { TableName: T, Key: { PK: S(`IDENTITY#${cfg.bIdentity}`), SK: S('ROUTE') } }],
  ];
  for (const [name, op, input] of mustDeny) {
    const check = `${p}:${name}`;
    let r;
    try { r = await session.call(op, input); } catch (e) { out.push(fail(check, `call failed: ${e instanceof Error ? e.message : String(e)}`)); continue; }
    if (r.ok) out.push(fail(check, `${op} SUCCEEDED for a session tagged tenant_id=${self}: IAM did not stop the access`));
    // Only an explicit authorization failure counts. A wrong table name, throttle or validation error is not isolation.
    else if (!r.errorType.includes('AccessDeniedException')) out.push(fail(check, `expected AccessDeniedException but got ${r.errorType}: ${r.message}`));
    else out.push(pass(check, 'AccessDeniedException'));
  }
  return out;
}
