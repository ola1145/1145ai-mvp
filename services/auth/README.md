# services/auth: Google sign-in and the pre-token trigger (P5)

Owners sign in through the Cognito hosted UI with Google. Google is the only identity provider and the scopes are
`openid email profile`, which need no Google verification or review (ADR-0005).

## What the pre-token trigger does (`src/pre-token.ts`)

On every token (hosted sign-in, refresh, etc.) it looks up the user's verified Cognito `sub` and sets these ID-token claims:

| Claim | Value |
|---|---|
| `custom:tenant_id` | tenant id from the key of the `MEMBER#<sub>` item (`TENANT#<tid>`) |
| `custom:role` | `owner` or `staff` from that item |
| `custom:state` | `active`, `suspended` or `over_cap` from `TENANT#<tid>` / `PROFILE` |

- A suspended tenant still signs in; the claim just says `custom:state=suspended`.
- An unknown user, an ambiguous membership (more than one tenant), a bad role or tenant id, a missing profile or an
  unknown state all produce no tenant claims, and `custom:tenant_id`, `custom:role`, `custom:state` are suppressed so
  a value stored on the user can never leak into a token.
- If DynamoDB cannot be read the trigger throws, so Cognito refuses the sign-in instead of issuing a token without a verdict.
- The app client cannot write `custom:tenant_id` or `custom:role` (not in `writeAttributes`), the Google mapping only
  carries email and name, and the trigger overrides the claims on every token anyway.
- IAM for the trigger: `dynamodb:Query` on `GSI1` with `LeadingKeys = MEMBER#*`, `dynamodb:GetItem` on the table with
  `LeadingKeys = TENANT#*` (profile state only), and `kms:Decrypt` through DynamoDB. No unconditioned table access.

The member lookup needs `GSI1PK = MEMBER#<sub>`, `GSI1SK = TENANT#<tid>` on the `MEMBER#` item. That is a contract
addition, see `contracts/CHANGE_REQUESTS/P5-1.md`. Until the writer of `MEMBER#` items adds it, every user gets no tenant claim.

## Owner follow-ups (need a real Google OAuth client and a dev account; not done by the agent)

1. In Google Cloud Console, create a project (or reuse one) and configure the OAuth consent screen:
   - User type External, publishing status can stay Testing for dev; for prod switch to In production.
   - Scopes: only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (the non-sensitive set, so no verification review).
2. Create an OAuth client ID, type Web application, one per stage.
   - Authorized redirect URI: `https://ai1145-<stage>.auth.<region>.amazoncognito.com/oauth2/idpresponse`
     (for example `https://ai1145-dev.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`).
   - Authorized JavaScript origins: the same hosted UI origin is enough; the app itself never talks to Google directly.
3. Store the client in Secrets Manager (dev account, region `us-east-1`) as a JSON secret named `ai1145/<stage>/google-oauth`
   with the keys `clientId` and `clientSecret`. Create it before the first deploy of `ai1145-<stage>-auth`, because the
   stack reads both values through a Secrets Manager dynamic reference. Do not commit these values anywhere.
4. Deploy through CI as usual. App callback URLs registered on the Cognito client:
   - dev: `https://app.dev.1145.ai/auth/callback`, prod: `https://app.1145.ai/auth/callback`
   - local: `http://localhost:3000/auth/callback`
5. Merge the `MEMBER#` index change (P5-1) so onboarding writes `GSI1PK`/`GSI1SK` on the member item.
6. Verify in dev with a real Google account: sign in at
   `https://ai1145-dev.auth.us-east-1.amazoncognito.com/login?client_id=<client id>&response_type=code&scope=openid+email+profile&redirect_uri=http://localhost:3000/auth/callback`,
   then decode the ID token. Before onboarding it has no `custom:tenant_id`; after onboarding creates the `MEMBER#` item it has
   `custom:tenant_id`, `custom:role` and `custom:state`.

## Tests

`pnpm vitest run services/auth` covers the handler (fake table) and CDK assertions on `AuthStack`
(`test/auth-stack.test.ts`; it lives here because `infra/cdk/test` belongs to P4).
