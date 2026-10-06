import { signV4, type AwsCreds } from '../sigv4.js';
import type { DataPlanePort, DdbResult, DdbSession } from '../types.js';

export interface AwsDataPlaneConfig { roleArn: string; region: string; creds: AwsCreds; timeoutMs?: number }

const tag = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

/**
 * Real adapter: sts:AssumeRole (with session tags) then DynamoDB JSON calls, both signed with our own SigV4.
 * Needs: the caller may assume the tenant data role with sts:TagSession, e.g. the CI role used for e2e.
 */
export function awsDataPlane(cfg: AwsDataPlaneConfig): DataPlanePort {
  const timeout = AbortSignal.timeout.bind(AbortSignal, cfg.timeoutMs ?? 20_000);
  return {
    async assumeRole(tags): Promise<DdbSession> {
      const form = new URLSearchParams({
        Action: 'AssumeRole', Version: '2011-06-15', RoleArn: cfg.roleArn,
        RoleSessionName: `isolation-${Date.now()}`, DurationSeconds: '900',
      });
      Object.entries(tags).forEach(([k, v], i) => { form.set(`Tags.member.${i + 1}.Key`, k); form.set(`Tags.member.${i + 1}.Value`, v); });
      const body = form.toString();
      const url = `https://sts.${cfg.region}.amazonaws.com/`;
      const headers = signV4({ method: 'POST', url, service: 'sts', region: cfg.region, creds: cfg.creds, body, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } });
      const res = await fetch(url, { method: 'POST', headers, body, signal: timeout() });
      const xml = await res.text();
      const accessKeyId = tag(xml, 'AccessKeyId'); const secretAccessKey = tag(xml, 'SecretAccessKey'); const sessionToken = tag(xml, 'SessionToken');
      if (!res.ok || !accessKeyId || !secretAccessKey || !sessionToken) {
        throw new Error(`sts:AssumeRole ${res.status} ${tag(xml, 'Code') ?? ''} ${tag(xml, 'Message') ?? xml.slice(0, 200)}`.trim());
      }
      const session: AwsCreds = { accessKeyId, secretAccessKey, sessionToken };
      return {
        async call(op, input): Promise<DdbResult> {
          const dUrl = `https://dynamodb.${cfg.region}.amazonaws.com/`;
          const dBody = JSON.stringify(input);
          const h = signV4({
            method: 'POST', url: dUrl, service: 'dynamodb', region: cfg.region, creds: session, body: dBody,
            headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${op}` },
          });
          const r = await fetch(dUrl, { method: 'POST', headers: h, body: dBody, signal: timeout() });
          const text = await r.text();
          let json: { __type?: string; message?: string; Message?: string } & Record<string, unknown> = {};
          try { json = JSON.parse(text) as typeof json; } catch { /* non-JSON error page */ }
          if (r.ok) return { ok: true, data: json };
          return { ok: false, errorType: json.__type ?? `HTTP ${r.status}`, message: json.message ?? json.Message ?? text.slice(0, 200) };
        },
      };
    },
  };
}
