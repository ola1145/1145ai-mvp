# Telegram bot setup (C2)

Owners can onboard and use the copilot in Telegram with no approvals (ADR-0005): BotFather hands out a bot in a minute.
`set-webhook.ts` points that bot at our webhook and registers its `/start` and `/help` menu.

How the pieces fit:

```
owner in Telegram -> POST <HooksUrl>/telegram   services/channels/src/telegram-webhook.ts
                     (X-Telegram-Bot-Api-Secret-Token checked first, private chats only)
                  -> SQS FIFO -> router (services/channels/src/router.ts) -> onboarding or admin agent
reply             <- services/channels/src/telegram-send.ts (sendMessage, 429 retry_after honored)
```

## One-time setup

1. **Create the bot.** In Telegram, message `@BotFather`, send `/newbot`, pick a name and a username ending in `bot`
   (the shared bot is `@1145_bot`). Copy the token it gives you.
2. **Keep it out of groups.** Still in BotFather: `/setjoingroups` -> your bot -> Disable. (The webhook ignores groups
   anyway; this stops people adding it.)
3. **Use one bot per stage.** A bot has exactly one webhook, so `dev` and `prod` need their own bots, each with its own
   token. Never point a dev deploy at the production bot.
4. **Put the values in `.env`** (git-ignored, read as plain `KEY=VALUE` data, never sourced):

   ```
   TELEGRAM_BOT_TOKEN=123456789:AA...        # from BotFather
   TELEGRAM_WEBHOOK_SECRET=<64 hex chars>    # openssl rand -hex 32
   ```

   Both names are listed in `docs/API_KEYS.md`. The secret must be 16 to 256 characters of letters, digits, `_` and `-`
   (Telegram's rule); `openssl rand -hex 32` always fits.
5. **Copy them to Secrets Manager.** `scripts/secrets/push.sh <owner>/<repo> dev` writes both into the runtime secret
   `1145/<stage>/runtime`. The webhook function reads `TELEGRAM_WEBHOOK_SECRET`; the router reads `TELEGRAM_BOT_TOKEN`.
6. **Find the webhook URL.** After the channels stack deploys, take its `HooksUrl` output and add `/telegram`, for
   example `https://abc123.execute-api.us-east-1.amazonaws.com/telegram`.

## Run it

Preview first. A dry run checks every input the real run needs, sends nothing, and prints no secret:

```
pnpm exec tsx scripts/telegram/set-webhook.ts --url https://abc123.execute-api.us-east-1.amazonaws.com/telegram --dry-run
```

Then for real (same command without `--dry-run`). It does four things, stopping at the first failure:

1. `getMe`: confirms the token works and prints the bot's username.
2. `setWebhook`: URL, `secret_token`, `allowed_updates: ["message"]`.
3. `setMyCommands`: `/start` and `/help`.
4. `getWebhookInfo`: confirms Telegram now holds the URL you set, and shows any delivery error it has seen.

| Option | What it does |
|---|---|
| `--url <url>` | Webhook URL. Falls back to `TELEGRAM_WEBHOOK_URL`. Must be `https`, end in `/telegram`, no credentials or query. |
| `--dry-run` | Validate and print the plan. No network calls. |
| `--drop-pending` | Also discard updates Telegram queued for the old webhook. Use after a long outage or when switching URLs. |
| `--info` | Show the bot, current webhook URL, updates waiting and the last delivery error. Changes nothing, needs no secret. |
| `--delete` | Remove the webhook. The bot stops receiving messages. Add `--drop-pending` to clear its backlog. |
| `--env-file <path>` | Read `TELEGRAM_*` from this file instead of `./.env`. The environment still wins over the file. |

Exit codes: `0` done, `1` Telegram or the network refused (or the webhook did not stick), `2` bad usage or config.

## Check that it works

```
pnpm exec tsx scripts/telegram/set-webhook.ts --info
```

then open `t.me/<bot>?start=TESTCODE` and press Start. You should get a reply from the onboarding agent within a few
seconds. A referral link `1145.ai/r/CODE` ends up as `/start CODE`, which the webhook parses (4 to 64 characters of
`A-Z a-z 0-9 _ -`) and hands to the router.

## Rotating the secret

1. Generate a new value and put it in `.env`.
2. `scripts/secrets/push.sh <owner>/<repo> <stage>` to update Secrets Manager. The webhook function caches the secret
   for up to a minute.
3. Run `set-webhook.ts` again. Until both sides match, the webhook answers 401, and Telegram holds those updates and
   retries them, so nothing is lost.

## When something is off

| `--info` shows | Meaning |
|---|---|
| `last delivery error: ... 401` | Telegram's secret does not match Secrets Manager. Run steps 2 and 3 above. |
| `last delivery error: ... 500` or `502` | The webhook function failed. Check that it has `RUNTIME_SECRET_ID` and can read the runtime secret (see `contracts/CHANGE_REQUESTS/C2-1.md`), and that `TELEGRAM_WEBHOOK_SECRET` is in it. |
| `updates waiting` keeps growing | Telegram cannot deliver. Same causes as above. |
| the bot never answers but `--info` is clean | The router or the agent is failing: look at the router Lambda and its DLQ. |

## Safety notes

- The token appears only in the path of requests to `api.telegram.org`. The script redacts it (and the secret) from
  every message it prints, including errors Telegram or the network send back.
- The webhook only acts on new messages from people in private chats. Groups, channels, bots, edits and button taps get
  a quiet `200` and are dropped. Who the sender is comes from Telegram's `from.id`, never from the message text.
- Never paste the token or the webhook secret into an issue, a PR or a chat. If one leaks, revoke the token with
  BotFather (`/revoke`) or rotate the secret as above.

## Tests

```
pnpm vitest run scripts/telegram services/channels/
```

Everything runs against fakes and recorded shapes of Bot API responses; nothing calls Telegram.
