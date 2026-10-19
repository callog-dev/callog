# Callog

Git-first routing for engineering notifications. CI jobs and services send an event to a
**route**; the config repo decides where it goes, how it looks and whom it mentions —
with one person mapped across GitHub, Slack and Telegram.

- [Self-hosting and your own database](docs/setup.md) · [Upgrading](docs/upgrade.md) · [Changelog](CHANGELOG.md)
- [GitHub Action](packages/action/README.md) · [Config validation CLI and Action](packages/cli/README.md)

## Self-hosting

You need Docker and Postgres 14+ (one is bundled). The setup below takes about fifteen minutes:
Callog walks you through the GitHub App, Slack and the config repo in the browser. For your own
database, TLS, poolers, scripted setup and registering the App by hand, see
**[docs/setup.md](docs/setup.md)**; upgrades — **[docs/upgrade.md](docs/upgrade.md)**.

### 1. Configure

```bash
cp .env.example .env
```

Set three lines in `.env` and leave the rest empty:

```bash
PUBLIC_URL=https://callog.acme.dev            # the address people will open; http://localhost:3000 to try it
ENCRYPTION_KEY=...                            # openssl rand -base64 32 — keep it with your database backups
CALLOG_IMAGE=ghcr.io/callog-dev/callog:0.2.0  # empty = build from source
```

### 2. Start

```bash
docker compose --profile db --profile app up -d   # bundled Postgres
docker compose --profile app up -d                # your Postgres in DATABASE_URL
```

The server checks and migrates the database on start; a problem is one line in
`docker compose logs app`.

### 3. Create the GitHub App

Open `PUBLIC_URL` and follow the page: enter your GitHub organization (you need to be an owner)
and confirm the App on GitHub. Callog shows its credentials **once**, as lines for `.env`. Add
them, restart (`docker compose --profile app up -d`) and install the App on the organization.

On a laptop GitHub cannot reach `localhost`: the page asks for a [smee.io](https://smee.io)
channel to relay webhooks. Keep the relay running while you try Callog:

```bash
npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/webhooks/github
```

### 4. Follow the checklist

Sign in with GitHub at `PUBLIC_URL`. Owners of the organization are admins; the **Getting
started** checklist in Admin covers the rest:

- **Slack** — a button creates Callog's Slack App from its manifest; paste its bot token and
  app-level token. People are imported from Slack and matched to GitHub accounts.
- **Your GitHub account** — run `/notify link github` in Slack, so notifications can mention
  you. Everyone links their accounts the same way (`/notify link github`, `/notify link telegram`).
- **Telegram** (optional) — paste a [@BotFather](https://t.me/BotFather) token; groups you add
  the bot to show up with their ids.
- **Config repo** — create `<org>/notify-config` from the
  [template](https://github.com/callog-dev/notify-config-template). It holds routing only: no
  logins or emails. Every push to its default branch is validated and loaded; an invalid config
  is rejected and the previous one stays active.
- **A first notification** — send a route's example to yourself and copy the
  [GitHub Action](packages/action/README.md) step that sends it from a workflow.

Services send with an API key (Admin → API keys) named in the route's
`allowed_sources.api_keys`:

```bash
curl -X POST $PUBLIC_URL/v1/notify \
  -H "Authorization: Bearer $NOTIFY_API_KEY" -H "Content-Type: application/json" \
  -d '{"route":"hello","data":{"text":"Deployed"},"recipients":["github:octocat"]}'
```

### Operating

- `GET /healthz` — liveness; `GET /readyz` — database reachable.
- `GET /metrics` — Prometheus (`callog_notifications_received_total`, `callog_deliveries_total`,
  `callog_delivery_latency_seconds`, `callog_unmapped_recipients_total`,
  `callog_config_reload_total`, `callog_queue_jobs`); set `METRICS_TOKEN` to require a bearer token.
- Logs are JSON in the container (`LOG_FORMAT=json`), `LOG_LEVEL` controls verbosity.
- `ROLE=api|worker|all` splits HTTP and queue workers across containers if needed. Run exactly
  one worker (Telegram allows one poller per bot); API containers scale freely.

## Development

```bash
pnpm install
pnpm db:up            # Postgres in Docker; in .env: DATABASE_URL=postgres://notify:notify@localhost:5432/notify
pnpm build && pnpm test && pnpm test:int
pnpm --filter @callog/server dev
```

`pnpm tunnel` forwards GitHub App webhooks from a [smee.io](https://smee.io) channel (`SMEE_URL`)
to the local server.

## License

`packages/*` — Apache-2.0, `apps/*` — AGPL-3.0-only. See [LICENSE.md](LICENSE.md).
