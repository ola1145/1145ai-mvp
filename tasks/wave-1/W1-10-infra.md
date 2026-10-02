# W1-10 · Data, events, realtime, auth infrastructure
**Agent:** infra-cdk · **Branch:** lane/infra · **Depends on:** W0-01, W0-05

## Owns
`infra/cdk/**`

## Steps
1. Cognito: Google IdP (secret in Secrets Manager), hosted domain, pre-token-generation Lambda that sets
   `custom:tenant_id` and `custom:role` from `MEMBER#` items. Users cannot write these attributes.
2. AppSync Events: verify the `tenants` namespace `onSubscribe` handler denies cross-tenant subscriptions; add a
   publisher Lambda (EventBridge rule → AppSync Events publish via IAM) for the types in `contracts/realtime/channels.md`.
3. EventBridge rules: `call.ended` → post-call; `message.taken`/`booking.created` → owner notifier (admin channel template).
4. Grant AgentCore invoke to the router; Bedrock access for post-call; S3 Vectors bucket per stage (Wave 2 if not GA in region).
5. Prod-only: provisioned concurrency on voice routes (already keyed off `stage=prod`); WAF rate limit on hooks API.

## Tests first
- CDK assertions (`infra/cdk/test/*.test.ts`): TenantDataRole policy has the LeadingKeys condition; trust has
  `sts:TagSession`; no Lambda in ApiStack has `dynamodb:*` on the table without a LeadingKeys condition;
  audit bucket has Object Lock.

## Acceptance
- `make synth` green; assertion tests green; `cdk diff` reviewed by you before first deploy.

## Status
- state: TODO
