# Telnyx connection setup (E1)

`setup.ts` creates or repairs the Telnyx side of the phone path. It never deletes anything and is safe to run twice.
It does not search, order or assign numbers; provisioning assigns each DID to the FQDN connection printed below.

| Resource | Name | What it does |
|---|---|---|
| Outbound voice profile | `1145-<stage>-outbound` | US and CA only; optional daily spend limit (`--daily-spend-limit`, use it on dev). |
| FQDN connection | `1145-<stage>-livekit-inbound` | Inbound calls for every number assigned to it, with E.164 dialed and caller numbers. |
| FQDN | the LiveKit SIP host, port 5060 | Where that connection sends calls. Derived from `LIVEKIT_URL`, or pass `--sip-host`. |
| Credential connection | `1145-<stage>-livekit-outbound` | The login LiveKit's outbound trunk uses; tied to the outbound voice profile. |

```
pnpm tsx scripts/telnyx/setup.ts --dry-run --daily-spend-limit 25
pnpm tsx scripts/telnyx/setup.ts --daily-spend-limit 25
```

The last line printed is `TELNYX_CONNECTION_ID=<id>` (not a secret). Put it in `.env`, then `scripts/secrets/push.sh`.

Environment (names from `docs/API_KEYS.md`, values never printed): `TELNYX_API_KEY`, `TELNYX_SIP_USERNAME`, `TELNYX_SIP_PASSWORD`,
and `LIVEKIT_URL` (unless `--sip-host` is given). Telnyx never returns a password, so use `--rotate-credentials` to push a new one.

Open items for the owner: transport (`--transport`, default TCP) and the SIP port are best-effort defaults; confirm them on the
first real call with E8. If Telnyx hosts LiveKit for you, pass its SIP host with `--sip-host`.

Tests use hand-written fixtures and an in-memory fake of the API (`pnpm vitest run scripts/telnyx`). Nothing in the tests or in CI calls Telnyx.
