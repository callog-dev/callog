# Callog

Git-first routing for engineering notifications. CI jobs and services send an event to a
**route**; the config repo decides where it goes, how it looks and whom it mentions —
with one person mapped across GitHub, Slack and Telegram.

- [Self-hosting and your own database](docs/setup.md) · [Upgrading](docs/upgrade.md) · [Changelog](CHANGELOG.md)
- [GitHub Action](packages/action/README.md) · [Config validation CLI and Action](packages/cli/README.md)

## Self-hosting

You need Docker and Postgres 14+. A Postgres is bundled in `docker-compose.yml` (profile `db`);
for your own database (managed or your DBA's), poolers, TLS and operator-applied migrations see
**[docs/setup.md](docs/setup.md)**. Upgrades: **[docs/upgrade.md](docs/upgrade.md)** and the
[CHANGELOG](CHANGELOG.md).

### 1. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable                                 | How to get it                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`                         | `openssl rand -base64 32` — encrypts Slack tokens at rest                        |
| `ADMIN_TOKEN`                            | `openssl rand -hex 24` — operator endpoints (`/admin/*`): connect Slack/Telegram |
| `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET` | Create a GitHub App in your org (below)                                          |
| `GITHUB_APP_PRIVATE_KEY_FILE`            | Path to the App's `.pem` on the host; mounted into the container                 |
| `APP_PORT`                               | Host port to publish (default 3000)                                              |
| `DATABASE_URL`                           | Only for your own Postgres ([docs/setup.md](docs/setup.md))                      |

**GitHub App** (org → Settings → Developer settings → GitHub Apps → New):
webhook URL `https://<your-server>/webhooks/github` with a secret; repository permissions
_Contents: read_, _Metadata: read_; organization permission _Members: read_; events _Push_
and _Organization_. Generate a private key, then install the App on the org — the
installation becomes your tenant.

### 2. Start

```bash
docker compose --profile db --profile app up -d --build   # bundled Postgres
docker compose --profile app up -d --build                # your Postgres in DATABASE_URL
```

With a release image instead of a local build, set `CALLOG_IMAGE=ghcr.io/callog-dev/callog:X.Y.Z`
in `.env` and drop `--build`. The server checks and migrates the database on start. Check it:

```bash
curl http://localhost:3000/readyz
```

### 3. Connect Slack

Create a Slack App from [docs/setup/slack-app-manifest.yaml](docs/setup/slack-app-manifest.yaml),
install it to your workspace and connect its bot token (`xoxb-…`). The tenant id is in the
server log line `Tenant … active for org …`.

```bash
curl -X PUT http://localhost:3000/admin/tenants/$TENANT_ID/slack \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"botToken":"xoxb-…"}'
```

Add `"appToken":"xapp-…"` (an app-level token with `connections:write`) to enable `/notify`
over Socket Mode. People are imported from Slack and matched to GitHub accounts
automatically; anyone can also link their own accounts with `/notify link github` (needs
`GITHUB_APP_CLIENT_ID`/`_SECRET`, `PUBLIC_URL` and the App callback URL
`$PUBLIC_URL/oauth/github/callback`) and `/notify link telegram`.

### Connect Telegram (optional)

Create a bot with @BotFather, connect it, then add it to a group — it posts the chat id to
use as `telegram: "<id>"` in routes.

```bash
curl -X PUT http://localhost:3000/admin/tenants/$TENANT_ID/telegram \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"botToken":"123456:…"}'
```

### 4. Add a config repo

Create `<org>/notify-config` with `config.yaml`, `teams.yaml` and `routes/*.yaml` — routing
only: no logins or emails, people are linked in the UI. The
[reference example](packages/config-schema/fixtures/valid) shows every file; validate changes
in CI with the [config Action](packages/cli/README.md). Every push to its default branch is
loaded; an invalid config is rejected and the previous one stays active.

```bash
curl http://localhost:3000/admin/tenants/$TENANT_ID/config -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 5. Send

From GitHub Actions use the [action](packages/action/README.md) (OIDC, no secrets). From a
service, create an API key and list its name in the route's `allowed_sources.api_keys`:

```bash
curl -X POST http://localhost:3000/admin/tenants/$TENANT_ID/api-keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"name":"billing"}'

curl -X POST http://localhost:3000/v1/notify \
  -H "Authorization: Bearer $NOTIFY_API_KEY" -H "Content-Type: application/json" \
  -d '{"route":"e2e-failed","data":{"branch":"main"},"recipients":["github:octocat"]}'
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
pnpm db:up            # Postgres in Docker
pnpm build && pnpm test && pnpm test:int
pnpm --filter @callog/server dev
```

`pnpm tunnel` forwards GitHub App webhooks from a [smee.io](https://smee.io) channel (`SMEE_URL`)
to the local server.

## License

`packages/*` — Apache-2.0, `apps/*` — AGPL-3.0-only. See [LICENSE.md](LICENSE.md).
