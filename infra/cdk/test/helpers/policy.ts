import type { CfnElement, Stack } from 'aws-cdk-lib';
import type { Template } from 'aws-cdk-lib/assertions';

/**
 * Reads every IAM and resource policy out of synthesized templates and turns each statement into one flat shape,
 * with references to the tenant table, tenant bucket, audit bucket, data key and TenantDataRole rendered as readable
 * symbols (TABLE_ARN, TENANT_BUCKET_ARN, ...). Stack-to-stack references become the same symbols, so a statement in
 * ApiStack that names the table reads exactly like one in DataStack.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface Symbols {
  /** Logical id in the data stack -> symbol base, e.g. TableCD117FA1 -> TABLE. */
  logical: Map<string, string>;
  /** Cross-stack export name -> full symbol, e.g. ...:ExportsOutputFnGetAttTableCD117FA1Arn... -> TABLE_ARN. */
  exports: Map<string, string>;
}

export interface DataConstructs {
  table: CfnElement;
  tenantBucket: CfnElement;
  auditBucket: CfnElement;
  dataKey: CfnElement;
  tenantDataRole: CfnElement;
}

const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Build the symbol table from the data stack and its synthesized template. */
export function symbolTable(data: Stack, dataTemplate: Template, c: DataConstructs): Symbols {
  const logical = new Map<string, string>([
    [data.getLogicalId(c.table), 'TABLE'],
    [data.getLogicalId(c.tenantBucket), 'TENANT_BUCKET'],
    [data.getLogicalId(c.auditBucket), 'AUDIT_BUCKET'],
    [data.getLogicalId(c.dataKey), 'DATA_KEY'],
    [data.getLogicalId(c.tenantDataRole), 'TENANT_ROLE'],
  ]);
  const exports = new Map<string, string>();
  const outputs = (dataTemplate.toJSON().Outputs ?? {}) as Record<string, { Value: Json; Export?: { Name: string } }>;
  for (const out of Object.values(outputs)) {
    const name = out.Export?.Name;
    if (!name || !isObject(out.Value)) continue;
    const getAtt = out.Value['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string' && typeof getAtt[1] === 'string' && logical.has(getAtt[0])) {
      exports.set(name, `${logical.get(getAtt[0])}_${getAtt[1].toUpperCase()}`);
    } else if (typeof out.Value.Ref === 'string' && logical.has(out.Value.Ref)) {
      exports.set(name, `${logical.get(out.Value.Ref)}_REF`);
    }
  }
  return { logical, exports };
}

const PSEUDO: Record<string, string> = { 'AWS::Partition': 'PARTITION', 'AWS::Region': 'REGION', 'AWS::AccountId': 'ACCOUNT', 'AWS::URLSuffix': 'URLSUFFIX' };

/** Render a template value as a plain string. IAM policy variables like ${aws:PrincipalTag/tenant_id} pass through untouched. */
export function render(value: Json | undefined, sym: Symbols): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => render(v, sym)).join(',');
  const join = value['Fn::Join'];
  if (Array.isArray(join) && Array.isArray(join[1])) return join[1].map((v) => render(v, sym)).join(String(join[0]));
  const getAtt = value['Fn::GetAtt'];
  if (Array.isArray(getAtt)) {
    const base = sym.logical.get(String(getAtt[0]));
    return base ? `${base}_${String(getAtt[1]).toUpperCase()}` : `<${String(getAtt[0])}.${String(getAtt[1])}>`;
  }
  if (typeof value.Ref === 'string') {
    const base = sym.logical.get(value.Ref);
    return PSEUDO[value.Ref] ?? (base ? `${base}_REF` : `<Ref:${value.Ref}>`);
  }
  const imported = value['Fn::ImportValue'];
  if (typeof imported === 'string') return sym.exports.get(imported) ?? `<Import:${imported}>`;
  const sub = value['Fn::Sub'];
  if (typeof sub === 'string') return sub;
  return `<${Object.keys(value)[0] ?? 'unknown'}>`;
}

export type Kind = 'identity' | 'resource' | 'trust';

export interface Statement {
  stack: string;
  /** Logical id of the policy, role, bucket policy or key that carries the statement. */
  source: string;
  kind: Kind;
  effect: 'Allow' | 'Deny';
  actions: string[];
  notAction: boolean;
  resources: string[];
  notResource: boolean;
  /** operator -> condition key -> values, all rendered as strings. */
  condition: Record<string, Record<string, string[]>>;
  principal: string;
  sid?: string;
}

const list = (v: Json | undefined): Json[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function toStatement(stack: string, source: string, kind: Kind, raw: JsonObject, sym: Symbols): Statement {
  const condition: Statement['condition'] = {};
  if (isObject(raw.Condition)) {
    for (const [op, keys] of Object.entries(raw.Condition)) {
      condition[op] = {};
      if (isObject(keys)) for (const [k, v] of Object.entries(keys)) condition[op]![k] = list(v).map((x) => render(x, sym));
    }
  }
  const principal = raw.Principal === undefined ? '' : isObject(raw.Principal) ? Object.entries(raw.Principal).map(([k, v]) => `${k}=${list(v).map((x) => render(x, sym)).join('|')}`).join(';') : render(raw.Principal, sym);
  return {
    stack, source, kind,
    effect: raw.Effect === 'Deny' ? 'Deny' : 'Allow',
    actions: list(raw.Action ?? raw.NotAction).map((a) => render(a, sym)),
    notAction: raw.NotAction !== undefined,
    resources: list(raw.Resource ?? raw.NotResource).map((r) => render(r, sym)),
    notResource: raw.NotResource !== undefined,
    condition, principal,
    ...(typeof raw.Sid === 'string' ? { sid: raw.Sid } : {}),
  };
}

/** Every `{ Statement: [...] }` document reachable from a resource's properties, with the kind of policy it is. */
function policyDocs(type: string, props: JsonObject): Array<[Kind, JsonObject]> {
  const out: Array<[Kind, JsonObject]> = [];
  const visit = (key: string, value: Json | undefined, depth: number) => {
    if (depth > 2 || value === undefined) return;
    if (Array.isArray(value)) { for (const v of value) visit(key, v, depth + 1); return; }
    if (!isObject(value)) return;
    if (value.Statement !== undefined) {
      out.push([key === 'AssumeRolePolicyDocument' ? 'trust' : type.startsWith('AWS::IAM::') ? 'identity' : 'resource', value]);
      return;
    }
    for (const [k, v] of Object.entries(value)) if (/Policy|ResourcePolicy$/.test(k)) visit(k, v, depth + 1);
  };
  for (const [k, v] of Object.entries(props)) if (/Policy|Policies/.test(k)) visit(k, v, 0);
  return out;
}

export function collectStatements(stack: string, template: Template, sym: Symbols): Statement[] {
  const out: Statement[] = [];
  const resources = (template.toJSON().Resources ?? {}) as Record<string, { Type: string; Properties?: JsonObject }>;
  for (const [id, res] of Object.entries(resources)) {
    for (const [kind, doc] of policyDocs(res.Type, res.Properties ?? {})) {
      for (const raw of list(doc.Statement)) if (isObject(raw)) out.push(toStatement(stack, id, kind, raw, sym));
    }
  }
  return out;
}

/** Logical ids of IAM policies (and the role's own inline policies) attached to a role, found by what they reference. */
export function statementsAttachedTo(template: Template, roleLogicalId: string, sym: Symbols, stack: string): Statement[] {
  const out: Statement[] = [];
  const resources = (template.toJSON().Resources ?? {}) as Record<string, { Type: string; Properties?: JsonObject }>;
  for (const [id, res] of Object.entries(resources)) {
    const props = res.Properties ?? {};
    const attached = (res.Type === 'AWS::IAM::Policy' || res.Type === 'AWS::IAM::ManagedPolicy')
      && JSON.stringify(props.Roles ?? []).includes(`"${roleLogicalId}"`);
    const inline = res.Type === 'AWS::IAM::Role' && id === roleLogicalId;
    if (!attached && !inline) continue;
    for (const [kind, doc] of policyDocs(res.Type, props)) {
      if (kind === 'trust') continue;
      for (const raw of list(doc.Statement)) if (isObject(raw)) out.push(toStatement(stack, id, kind, raw, sym));
    }
  }
  return out;
}
