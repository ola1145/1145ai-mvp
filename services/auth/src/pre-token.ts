/**
 * Cognito pre-token-generation trigger (issue P5).
 *
 * Sets custom:tenant_id, custom:role and custom:state on the ID token from the user's MEMBER# item. The values come
 * from our table keyed by the verified Cognito `sub`; nothing the user or Google supplies is trusted (ADR-0003).
 * Anything we cannot verify yields NO tenant claim, and any value already stored on the user is suppressed.
 *
 * Lookup: the MEMBER# item lives at PK TENANT#<tid>, SK MEMBER#<sub>, so finding it by sub needs an index entry
 * GSI1PK = MEMBER#<sub>, GSI1SK = TENANT#<tid> (see contracts/CHANGE_REQUESTS/P5-1.md).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId } from '@1145/shared';

export interface PreTokenEvent {
  version?: string;
  triggerSource?: string;
  region?: string;
  userPoolId?: string;
  userName?: string;
  callerContext?: { awsSdkVersion?: string; clientId?: string };
  request: { userAttributes: Record<string, string>; [k: string]: unknown };
  response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride?: Record<string, string>;
      claimsToSuppress?: string[];
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
}

export interface MemberRow { PK: string; SK: string; role?: string }

/** The only two reads the trigger needs. Narrow on purpose so IAM can be narrow too. */
export interface AuthTable {
  /** MEMBER# items for a Cognito sub (GSI1PK = MEMBER#<sub>). */
  findMembers(sub: string): Promise<MemberRow[]>;
  /** TENANT#<tid> / PROFILE, state only. Null when there is no profile. */
  getProfile(tenantId: string): Promise<{ state?: string } | null>;
}

const CLAIMS = { tenantId: 'custom:tenant_id', role: 'custom:role', state: 'custom:state' } as const;
const ROLES = new Set(['owner', 'staff']);
const STATES = new Set(['active', 'suspended', 'over_cap']);

function noTenant(event: PreTokenEvent, reason: string, sub: string): PreTokenEvent {
  // Log the reason and sub only; no emails or attribute values.
  console.warn(JSON.stringify({ msg: 'pre-token: no tenant claim', reason, sub }));
  const details = event.response.claimsOverrideDetails ?? {};
  delete details.claimsToAddOrOverride;
  details.claimsToSuppress = [CLAIMS.tenantId, CLAIMS.role, CLAIMS.state];
  event.response.claimsOverrideDetails = details;
  return event;
}

export function createHandler(table: AuthTable) {
  return async (event: PreTokenEvent): Promise<PreTokenEvent> => {
    // Only the verified sub identifies the user. Not userName, not email, not any custom attribute.
    const sub = event.request?.userAttributes?.sub;
    if (!sub || sub.includes('#')) throw new Error('pre-token: event has no usable sub');

    // Reads throw on failure: Cognito then refuses the sign-in instead of minting a token with no verdict.
    const members = await table.findMembers(sub);
    if (members.length === 0) return noTenant(event, 'no_member', sub);
    if (members.length > 1) return noTenant(event, 'ambiguous_membership', sub);

    const m = members[0];
    if (!m) return noTenant(event, 'no_member', sub);
    const role = m.role ?? '';
    if (!ROLES.has(role)) return noTenant(event, 'bad_role', sub);

    let tenantId: string;
    try {
      if (!m.PK.startsWith('TENANT#') || m.SK !== `MEMBER#${sub}`) throw new Error('unexpected key');
      tenantId = asTenantId(m.PK.slice('TENANT#'.length));
    } catch {
      return noTenant(event, 'bad_tenant_id', sub);
    }

    const profile = await table.getProfile(tenantId);
    if (!profile) return noTenant(event, 'no_profile', sub);
    if (!profile.state || !STATES.has(profile.state)) return noTenant(event, 'unknown_state', sub);

    // A suspended tenant still signs in (the owner needs to see why); the app and tool API act on custom:state.
    event.response.claimsOverrideDetails = {
      ...event.response.claimsOverrideDetails,
      claimsToAddOrOverride: { [CLAIMS.tenantId]: tenantId, [CLAIMS.role]: role, [CLAIMS.state]: profile.state },
    };
    return event;
  };
}

export function dynamoAuthTable(tableName: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))): AuthTable {
  return {
    async findMembers(sub) {
      const res = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :tp)',
        ExpressionAttributeValues: { ':pk': `MEMBER#${sub}`, ':tp': 'TENANT#' },
        Limit: 2,
      }));
      return (res.Items ?? []) as MemberRow[];
    },
    async getProfile(tenantId) {
      const res = await client.send(new GetCommand({
        TableName: tableName,
        Key: { PK: `TENANT#${tenantId}`, SK: 'PROFILE' },
        ProjectionExpression: 'PK, SK, #s',
        ExpressionAttributeNames: { '#s': 'state' },
      }));
      return res.Item ? { state: res.Item.state as string | undefined } : null;
    },
  };
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: PreTokenEvent): Promise<PreTokenEvent> => {
  cached ??= createHandler(dynamoAuthTable(process.env.TABLE_NAME ?? ''));
  return cached(event);
};
