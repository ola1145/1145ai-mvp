import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildChannels, sharedApp, type Stage } from './helpers/app.js';
import { analyze } from './helpers/scope.js';

/**
 * ADR-0005: no third-party approvals in the MVP. WhatsApp needs one, so its webhook route (and the Lambda behind it)
 * must not exist unless someone deploys with `-c enableWhatsApp=true`, and nothing committed may turn that on.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Template = ReturnType<typeof buildChannels>['template'];
const routeKeys = (t: Template) => Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r) => String((r.Properties as { RouteKey: string }).RouteKey)).sort();
const lambdaIds = (t: Template) => Object.keys(t.findResources('AWS::Lambda::Function')).sort();

// What the stack deploys with the flag off. A new route is fine; it just has to be added here on purpose.
const BASE_ROUTES = ['GET /r/{code}', 'POST /telegram', 'POST /v1/owner-chat/messages', 'POST /v1/webchat/token'];

describe('WhatsApp webhook (ChannelsStack)', () => {
  it('is absent by default: no /whatsapp route, no integration, no Lambda', () => {
    const { template } = buildChannels();
    expect(routeKeys(template)).toEqual(BASE_ROUTES);
    expect(routeKeys(template).filter((k) => /whatsapp/i.test(k))).toEqual([]);
    expect(lambdaIds(template).filter((id) => /whatsapp/i.test(id))).toEqual([]);
    expect(Object.keys(template.findResources('AWS::ApiGatewayV2::Integration')).filter((id) => /whatsapp|WaInt/i.test(id))).toEqual([]);
    expect(JSON.stringify(template.toJSON()).toLowerCase()).not.toContain('whatsapp');
  });

  it.each(['false', '', '0', 'no', 'off'])('stays absent when enableWhatsApp is %j', (value) => {
    const { template } = buildChannels({ enableWhatsApp: value });
    expect(routeKeys(template)).toEqual(BASE_ROUTES);
    expect(JSON.stringify(template.toJSON()).toLowerCase()).not.toContain('whatsapp');
  });

  it('appears only with enableWhatsApp=true, for GET (verification) and POST, and adds nothing else', () => {
    const off = buildChannels();
    const on = buildChannels({ enableWhatsApp: 'true' });
    expect(routeKeys(on.template)).toEqual([...BASE_ROUTES, 'GET /whatsapp', 'POST /whatsapp'].sort());
    const added = lambdaIds(on.template).filter((id) => !lambdaIds(off.template).includes(id));
    expect(added.map((id) => id.replace(/[0-9A-F]{8}$/, ''))).toEqual(['WhatsAppWebhook']);
    // The webhook may enqueue to the router queue and nothing more: no new permissions beyond SQS send for its own role.
    const t = on.template.toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, any> }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rolePolicy = Object.entries(t.Resources).find(([id, r]) => r.Type === 'AWS::IAM::Policy' && id.startsWith('WhatsAppWebhookServiceRole'));
    expect(rolePolicy, 'a policy for the webhook role').toBeDefined();
    const actions = (rolePolicy![1].Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>).flatMap((s) => [s.Action].flat());
    expect(actions.sort()).toEqual(['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage']);
  });

  it('is absent from every stack in the app by default, in dev and prod', async () => {
    for (const stage of ['dev', 'prod'] as Stage[]) {
      const built = await sharedApp({ stage });
      for (const [key, template] of Object.entries(built.templates)) {
        expect(JSON.stringify(template.toJSON()).toLowerCase(), `${stage}/${key}`).not.toContain('whatsapp');
      }
    }
  });
});

describe('nothing committed turns WhatsApp on', () => {
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

  it('cdk.json does not set enableWhatsApp to a true value', () => {
    const cdk = JSON.parse(read('infra/cdk/cdk.json')) as { context?: Record<string, unknown> };
    const value = cdk.context?.enableWhatsApp;
    expect([undefined, false, 'false']).toContain(value);
  });

  it('no workflow, Makefile or package script passes enableWhatsApp', () => {
    const files = [
      ...fs.readdirSync(path.join(REPO, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`),
      'Makefile', 'package.json', 'infra/cdk/package.json', 'infra/cdk/cdk.json',
    ];
    for (const f of files) expect(read(f), f).not.toMatch(/enableWhatsApp/i);
  });
});

describe('no third-party approvals in IAM (ADR-0005)', () => {
  it.each(['dev', 'prod'] as Stage[])('grants nothing for WhatsApp, SMS or SES in %s', async (stage) => {
    const a = analyze(await sharedApp({ stage }));
    const banned = /^(social-messaging|sms-voice|mobiletargeting|pinpoint|ses|sesv2):/i;
    const hits = a.statements.filter((s) => s.actions.some((x) => banned.test(x)));
    expect(hits.map((s) => `${s.stack}/${s.source}: ${s.actions.join(', ')}`)).toEqual([]);
  });
});
