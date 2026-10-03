# LiveKit SIP setup (E1)

`setup.ts` creates or repairs the LiveKit side of the phone path. It never deletes anything and is safe to run twice.

| Resource | Name | What it does |
|---|---|---|
| Inbound trunk | `1145-<stage>-telnyx-inbound` | Accepts every number on the Telnyx connection (empty `numbers`). Optional `--allowed-addresses` limits sources. |
| Outbound trunk | `1145-<stage>-telnyx-outbound` | Dials out through `sip.telnyx.com` with the Telnyx credential connection, for transfers and smoke calls. |
| Dispatch rule | `1145-<stage>-frontdesk` | One room per call (`call-` prefix), dispatches agent `frontdesk`, bound to the inbound trunk only. |

```
pnpm tsx scripts/livekit/setup.ts --dry-run          # read-only plan
pnpm tsx scripts/livekit/setup.ts                    # apply
pnpm tsx scripts/livekit/setup.ts --rotate-credentials   # re-send the outbound password (LiveKit never echoes it back)
```

Environment (names from `docs/API_KEYS.md`, values never printed): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
`TELNYX_SIP_USERNAME`, `TELNYX_SIP_PASSWORD`.

Run `scripts/telnyx/setup.ts` as well; it creates the Telnyx side. Order does not matter, but both must exist before a call works.

Tests use hand-written fixtures and an in-memory fake of the API (`pnpm vitest run scripts/livekit`). Nothing in the tests or in
CI calls LiveKit. A real call to a dev number (with E8) is the owner's acceptance check.
