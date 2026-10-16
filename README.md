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

Fill in `.env` (leave everything else as is; empty lines mean "not set"):

| Variable                                           | How to get it                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ENCRYPTION_KEY`                                   | `openssl rand -base64 32` — encrypts Slack and Telegram tokens at rest               |
| `ADMIN_TOKEN`                                      | `openssl rand -hex 24` — operator endpoints (`/admin/*`): connect Slack and Telegram |
| `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`           | The GitHub App (below)                                                               |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | The same App → _Client ID_ / _Generate a new client secret_: sign-in to the web UI   |
| `GITHUB_APP_PRIVATE_KEY_FILE`                      | Path to the App's `.pem` on the host; mounted into the container                     |
| `PUBLIC_URL`                                       | The URL people open in the browser, e.g. `https://callog.acme.dev`                   |
| `APP_PORT`                                         | Host port to publish (default 3000)                                                  |
| `CALLOG_IMAGE`                                     | A release image, e.g. `ghcr.io/callog-dev/callog:0.1.1`; empty = build from source   |
| `DATABASE_URL`                                     | Only for your own Postgres ([docs/setup.md](docs/setup.md)); empty = bundled one     |

**GitHub App** (org → Settings → Developer settings → GitHub Apps → New):

- webhook URL `$PUBLIC_URL/webhooks/github` with a secret (to try it on a laptop, point it at a
  [smee.io](https://smee.io) channel and forward it with `pnpm tunnel`, see Development);
- callback URL `$PUBLIC_URL/oauth/github/callback`;
- repository permissions _Contents: read_, _Metadata: read_; organization permission
  _Members: read_; events _Push_ and _Organization_.

Generate a private key, then install the App on the org — the installation becomes your tenant.

### 2. Start

```bash
docker compose --profile db --profile app up -d   # bundled Postgres
docker compose --profile app up -d                # your Postgres in DATABASE_URL
```

Add `--build` to build the image from source instead of `CALLOG_IMAGE`. The server checks and
migrates the database on start; a problem with the database is one line in
`docker compose logs app`. After a few seconds:

```bash
CALLOG=http://localhost:3000   # your PUBLIC_URL; the examples below use it
curl $CALLOG/readyz
docker compose logs app | grep "Tenant "   # → Tenant <TENANT_ID> active for org "<org>"
```

### 3. Connect Slack

Create a Slack App from [docs/setup/slack-app-manifest.yaml](docs/setup/slack-app-manifest.yaml),
install it to your workspace and create an app-level token (`xapp-…`, scope `connections:write`)
for `/notify` over Socket Mode. Then connect both tokens:

```bash
curl -X PUT $CALLOG/admin/tenants/$TENANT_ID/slack \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"botToken":"xoxb-…","appToken":"xapp-…"}'
```

People are imported from Slack and matched to GitHub accounts automatically where possible.

**Sign in to the web UI.** Sign-in is with GitHub, so your GitHub account must be linked first:
run `/notify link github` in Slack, open the link and confirm, then sign in at `$PUBLIC_URL`.
GitHub org owners are admins (`/manage`) and can grant the role to others there. Anyone can link
their accounts the same way (`/notify link github`, `/notify link telegram`).

### Connect Telegram (optional)

Create a bot with @BotFather, connect it, then add it to a group — it posts the chat id to
use as `telegram: "<id>"` in routes.

```bash
curl -X PUT $CALLOG/admin/tenants/$TENANT_ID/telegram \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"botToken":"123456:…"}'
```

### 4. Add a config repo

Create `<org>/notify-config` with `config.yaml`, `teams.yaml` and `routes/*.yaml` — routing
only: no logins or emails, people are linked in the UI. The
[reference example](packages/config-schema/fixtures/valid) shows every file; validate changes
in CI with the [config Action](packages/cli/README.md). It is loaded when the App is installed
and on every push to its default branch; an invalid config is rejected and the previous one
stays active.

```bash
curl $CALLOG/admin/tenants/$TENANT_ID/config -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 5. Send

From GitHub Actions use the [action](packages/action/README.md) (OIDC, no secrets). From a
service, create an API key named as in the route's `allowed_sources.api_keys` (`ci` here); the
response contains the key once:

```bash
curl -X POST $CALLOG/admin/tenants/$TENANT_ID/api-keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"name":"ci"}'

curl -X POST $CALLOG/v1/notify \
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
pnpm db:up            # Postgres in Docker; in .env: DATABASE_URL=postgres://notify:notify@localhost:5432/notify
pnpm build && pnpm test && pnpm test:int
pnpm --filter @callog/server dev
```

`pnpm tunnel` forwards GitHub App webhooks from a [smee.io](https://smee.io) channel (`SMEE_URL`)
to the local server.

## License

`packages/*` — Apache-2.0, `apps/*` — AGPL-3.0-only. See [LICENSE.md](LICENSE.md).
