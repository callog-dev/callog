# Self-hosting: installation and your own database

The step-by-step start (GitHub App, Slack, Telegram, config repo) is in the
[README](../README.md#self-hosting). This page is for whoever runs the infrastructure and the
database: what an installation consists of, what it needs from Postgres, how to use your own
database instead of the bundled one, and how to set Callog up without the browser.

## 1. What an installation consists of

| Component | What it is                                                                       | State                       |
| --------- | -------------------------------------------------------------------------------- | --------------------------- |
| `app`     | One Docker image: API, web UI, queue worker, Slack Socket Mode, Telegram polling | stateless                   |
| Postgres  | All data, including the job queue (graphile-worker)                              | **the only** stateful piece |

There are no other services: no Redis, no message broker. Backing up an installation means
backing up Postgres and `.env` (with the GitHub App private key, or the `.pem` if you mount one).
Keep `ENCRYPTION_KEY` with the database backups: the Slack and Telegram tokens in the database
are encrypted with it and cannot be read without it.

Run **one** `app` process with the worker (`ROLE=all` or `ROLE=worker`): Telegram long polling
allows a single poller per bot. API-only processes (`ROLE=api`) can be scaled freely.

## 2. Bundled Postgres or your own

**Bundled** (`docker-compose.yml`, profile `db`) — for trying it out and small installations:

```bash
docker compose --profile db --profile app up -d
```

Backups are up to you, for example `pg_dump` from cron:

```bash
docker compose exec -T postgres pg_dump -U notify -Fc notify > notify-$(date +%F).dump
```

**Your own** (managed RDS / Cloud SQL / Supabase / Neon, or your DBA's Postgres) — recommended
for production: backups, upgrades and monitoring stay in your infrastructure. Leave the `db`
profile off and set the database URL in `.env`:

```bash
DATABASE_URL=postgres://notify:<password>@db.internal:5432/notify?sslmode=require
docker compose --profile app up -d
```

## 3. Database requirements

- **PostgreSQL 14 or newer.** Other databases are not supported.
- **A dedicated database owned by a dedicated role:**

  ```sql
  CREATE ROLE notify LOGIN PASSWORD '…';
  CREATE DATABASE notify OWNER notify;
  ```

  A server running as the database owner applies all migrations itself — the simplest setup.
  No superuser and no extensions are needed (`gen_random_uuid()` is built in). If the server's
  role must not have DDL rights, see [Migrations](#5-migrations).

- **Connections:** one process holds up to ~20 (application pool plus queue worker). Multiply by
  the number of `app` replicas.
- **TLS:** add `?sslmode=require` to `DATABASE_URL`. If the server certificate is signed by an
  internal CA, pass it: `DATABASE_SSL_CA_PATH=/run/secrets/db-ca.pem` (mount the file) or the PEM
  itself in `DATABASE_SSL_CA`. With a CA the certificate is always verified.

## 4. Connection poolers (PgBouncer, RDS Proxy, Supabase/Neon pooler)

The queue (graphile-worker) learns about new jobs through `LISTEN/NOTIFY`, which needs a real
session. A pooler in **transaction** mode does not provide one: the worker keeps running but only
sees jobs when it polls every couple of seconds, and delivery becomes noticeably slower.

Give the worker a direct address:

```bash
DATABASE_URL=postgres://notify:…@pooler.internal:6432/notify          # API — through the pooler
DATABASE_URL_DIRECT=postgres://notify:…@db.internal:5432/notify       # worker — direct
```

If `DATABASE_URL` looks like a pooler (port 6432, `pooler`/`pgbouncer` in the host name,
`pgbouncer=true`) and `DATABASE_URL_DIRECT` is not set, the server logs a warning at start.

## 5. Migrations

**By default** the server applies migrations itself at start (`MIGRATE_ON_START=true`).
Migrations only go forward and stay compatible with the previous release, so rolling the image
back by one version does not require rolling the database back.

**When a DBA applies migrations** (the server's role has no DDL rights — a common enterprise
requirement), there are two roles: the owner of the application schema (the DBA's) and the role
the server runs as.

One thing to know about the queue: graphile-worker enables row-level security on its tables, so
**only their owner** can use them. The `graphile_worker` schema therefore belongs to the server's
role. The server creates it on its first start, which needs the right to create **schemas** (not
tables in `public`).

Once, at installation:

```sql
-- owner of the database and of the application schema
CREATE ROLE notify_owner LOGIN PASSWORD '…';
CREATE DATABASE notify OWNER notify_owner;
-- the role the server runs as
CREATE ROLE notify_app LOGIN PASSWORD '…';
\c notify
REVOKE CREATE ON SCHEMA public FROM PUBLIC;           -- PG 14 allows it to everyone by default
GRANT CREATE ON DATABASE notify TO notify_app;        -- new schemas only: the queue
```

Before every release (and at installation):

1. The DBA applies the application schema migrations as the owner, skipping the queue schema:
   - `docker compose run --rm -e DATABASE_URL=postgres://notify_owner:…@db/notify app node dist/db/migrate.cli.js --app-only`;
   - or the SQL files from `migrations-vX.Y.Z.tar.gz` in the GitHub Release (`drizzle/`, in
     order). The `drizzle.__drizzle_migrations` bookkeeping is then up to you as well, so
     `migrate.cli.js` is preferred.
2. Grants the server's role access to the data (new tables arrive with migrations — repeat after
   each one):

   ```sql
   GRANT USAGE ON SCHEMA public, drizzle TO notify_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO notify_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO notify_app;
   GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO notify_app;   -- the start-up check reads it
   ```

   To avoid repeating it: `ALTER DEFAULT PRIVILEGES FOR ROLE notify_owner IN SCHEMA public GRANT
SELECT, INSERT, UPDATE, DELETE ON TABLES TO notify_app;`.

3. The server starts as `notify_app` with `MIGRATE_ON_START=false` and migrates the queue schema
   itself. If application migrations are missing, it refuses to start and says how many.

## 6. Start-up check

Before the application starts, the server checks the database and, on a problem, exits with
**one line** in the log instead of a stack trace:

| Check                                            | Message                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Postgres ≥ 14                                    | `PostgreSQL N is not supported`                                     |
| The queue schema belongs to another role         | `The queue schema "graphile_worker" is owned by "…"`                |
| No queue yet and the role cannot create schemas  | `Role "…" cannot create the queue schema on first start`            |
| Pending migrations with `MIGRATE_ON_START=false` | `N database migration(s) are pending and MIGRATE_ON_START=false`    |
| Pending migrations and the role lacks `CREATE`   | `N database migration(s) are pending, but role "…" cannot run them` |

DDL rights in `public` are only checked when there is something to apply: on a migrated database
a role without DDL works with `MIGRATE_ON_START=true` too. Every message includes the command to
fix it.

Logs: `docker compose logs app`.

## 7. Database environment variables

| Variable               | Default | Purpose                                                          |
| ---------------------- | ------- | ---------------------------------------------------------------- |
| `DATABASE_URL`         | —       | Main connection                                                  |
| `DATABASE_URL_DIRECT`  | —       | Direct connection for the queue worker (behind a pooler)         |
| `DATABASE_SSL_CA`      | —       | PEM of an internal CA                                            |
| `DATABASE_SSL_CA_PATH` | —       | The same, as a file path                                         |
| `MIGRATE_ON_START`     | `true`  | `false` — an operator applies migrations, the server only checks |

Upgrading: [upgrade.md](upgrade.md).

## 8. Registering the GitHub App by hand

The setup page creates the App with GitHub's manifest flow. If you cannot use it (no owner
rights for the browser session, or the App is managed by another team), register it yourself:
organization → Settings → Developer settings → GitHub Apps → New GitHub App.

- Homepage URL: `$PUBLIC_URL`.
- Callback URL: `$PUBLIC_URL/oauth/github/callback` (sign-in and `/notify link github`).
- Webhook: active, URL `$PUBLIC_URL/webhooks/github`, a secret of your choice.
- Repository permissions: _Contents: read_, _Metadata: read_. Organization permission:
  _Members: read_. Events: _Push_, _Organization_.
- Where it can be installed: only this account.

Then generate a private key and a client secret, install the App on the organization and fill
in `.env`:

| Variable                                           | Where                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `GITHUB_APP_ID`                                    | The App's page → _App ID_                                                |
| `GITHUB_WEBHOOK_SECRET`                            | The secret you set for the webhook                                       |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | _Client ID_ / _Generate a new client secret_                             |
| `GITHUB_APP_PRIVATE_KEY_FILE`                      | Host path of the downloaded `.pem`; compose mounts it into the container |

Instead of a file, the key can go into `GITHUB_APP_PRIVATE_KEY` as one line with `\n` between
its lines (that is what the setup page prints). Secrets managers (Vault, Kubernetes secrets)
work the same way: the server only reads these variables at start.

## 9. Setting up without the browser

Everything the Admin pages do on first start is also an HTTP API for scripts, protected by
`ADMIN_TOKEN` (`openssl rand -hex 24`; `/admin/*` answers 404 while it is not set). The tenant
ID is in Admin → Settings, or in the log when the App installation is picked up
(`docker compose logs app | grep "Tenant "`).

```bash
H="Authorization: Bearer $ADMIN_TOKEN"

# Slack: bot token and the app-level token (connections:write) for /notify
curl -X PUT $PUBLIC_URL/admin/tenants/$TENANT_ID/slack -H "$H" -H "Content-Type: application/json" \
  -d '{"botToken":"xoxb-…","appToken":"xapp-…"}'

# Telegram (optional)
curl -X PUT $PUBLIC_URL/admin/tenants/$TENANT_ID/telegram -H "$H" -H "Content-Type: application/json" \
  -d '{"botToken":"123456:…"}'

# The active config, and loading the config repo now
curl $PUBLIC_URL/admin/tenants/$TENANT_ID/config -H "$H"
curl -X POST $PUBLIC_URL/admin/tenants/$TENANT_ID/config/reload -H "$H"

# An API key for a service; the response contains the key once
curl -X POST $PUBLIC_URL/admin/tenants/$TENANT_ID/api-keys -H "$H" -H "Content-Type: application/json" \
  -d '{"name":"ci"}'
```

The Slack App is created from [setup/slack-app-manifest.yaml](setup/slack-app-manifest.yaml)
(api.slack.com/apps → Create New App → From an app manifest).
