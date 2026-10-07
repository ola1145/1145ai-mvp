import { describe, expect, it } from 'vitest';
import { sharedApp, type Stage } from './helpers/app.js';

/**
 * Which HTTP API routes are open to the internet. Most routes verify a token or a webhook signature inside the Lambda,
 * which is fine, but the routes below carry staff, service-to-service or logged-in-owner traffic, so API Gateway
 * itself must authenticate them. A new route that is not listed here is not restricted by this test.
 */

const MUST_AUTHENTICATE: Array<{ prefix: RegExp; type: 'AWS_IAM' | 'JWT'; what: string }> = [
  { prefix: /\/console\//, type: 'AWS_IAM', what: 'admin console (1145 staff, SigV4)' },
  { prefix: /\/internal\/resolve\//, type: 'AWS_IAM', what: 'number and widget resolver (voice worker, SigV4)' },
  { prefix: /\/dash\//, type: 'JWT', what: 'owner dashboard (Cognito)' },
  { prefix: /\/v1\/owner-chat\//, type: 'JWT', what: 'owner chat (Cognito)' },
];

const apps = { dev: await sharedApp({ stage: 'dev' }), prod: await sharedApp({ stage: 'prod' }) };

describe.each(['dev', 'prod'] as Stage[])('HTTP API authentication in %s', (stage) => {
  const routes = Object.entries(apps[stage].templates).flatMap(([stack, template]) =>
    Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => ({ stack, ...(r.Properties as { RouteKey: string; AuthorizationType?: string }) })));

  it('sees the routes it is meant to police', () => {
    for (const rule of MUST_AUTHENTICATE) expect(routes.some((r) => rule.prefix.test(r.RouteKey)), rule.what).toBe(true);
  });

  for (const rule of MUST_AUTHENTICATE) {
    it(`never leaves ${rule.what} open: ${rule.type}`, () => {
      for (const r of routes.filter((x) => rule.prefix.test(x.RouteKey))) expect(r.AuthorizationType, `${r.stack}: ${r.RouteKey}`).toBe(rule.type);
    });
  }
});
