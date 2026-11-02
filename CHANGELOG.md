# Changelog

All notable changes to Callog. The format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/): a **minor** release is a regular upgrade
(`docker compose pull && up -d`, or `helm upgrade`), a **major** release needs the steps in
[docs/upgrade.md](docs/upgrade.md). Every release has an
**Operator actions** section, even when it says "none".

## [0.4.0]

### Added

- The web UI has a sidebar and a URL for every page, filter and record, so a link opens the same
  view. Cmd+K (Ctrl+K) jumps to a page, a route, a person or a notification.
- Overview lists what needs attention, each item linking to where it is fixed.
- Deliveries: filters by status, route, sender and period; a notification opens at
  `/manage/deliveries/<id>`; a failed or partially failed notification can be sent again (its
  failed deliveries only, in its thread); new notifications show up without a reload.
- People: server-side search by name or account, tabs for unmapped recipients and suggested
  links, and a page per person with their accounts, role and latest notifications.
- Config: the history of config pushes, with the errors of a rejected one linked to its files.
- A page per route; admins also see its template and examples and can send a test.
- Integrations: disconnect Slack or Telegram, sync people and send test messages from the UI.
- Settings → Maintenance: sync this workspace's people or apply its retention now.
- Retries and maintenance runs are recorded in the audit log.

### Changed

- My notifications lists muted routes with an unmute button; muting can be undone from the
  notification that confirms it.
- Hashed web assets are served with `Cache-Control: immutable`.

### Operator actions

None.

## [0.3.0]

### Added

- A Helm chart, `oci://ghcr.io/callog-dev/charts/callog`, released with the app: an api
  Deployment, exactly one worker that applies migrations, and an optional webhook-only ingress.
  See [charts/callog/README.md](charts/callog/README.md).
- `GITHUB_WEBHOOK_URL`: the setup page gives a new GitHub App this webhook address instead of
  `PUBLIC_URL/webhooks/github`, so the UI can stay internal while only webhooks are public.
- `GITHUB_APP_PRIVATE_KEY` (or the file at `GITHUB_APP_PRIVATE_KEY_PATH`) may also be the `.pem`
  in base64; the setup page prints the key that way too. A key that is neither stops the server
  with one line.

### Changed

- The setup page shows where GitHub will send webhooks, and the credentials page no longer
  assumes docker compose.
- README: where to get the files, and the address GitHub Actions runners need to reach.
- The bundled Postgres no longer creates the test-only `notify_test` database. An existing one
  can be dropped: `docker compose exec postgres dropdb -U notify notify_test`.

### Fixed

- A renamed GitHub organization is picked up without a restart: the `organization.renamed`
  webhook updates the tenant's org login and reloads its config, and the hourly sync re-reads
  the installations in case the webhook was missed. Before, the GitHub identity sync, team
  expansion for `members_from`, org-owner admin checks and the default config repository
  (`<org>/notify-config`) kept using the old name until the server was restarted.

### Operator actions

- After renaming a GitHub organization, update `allowed_sources.github_repos` in your routes to
  the new `<org>/<repo>` names: GitHub signs OIDC tokens with the new repository name, and the
  server does not rewrite your config repository. Until then, requests from those workflows are
  rejected with 403.
- Nothing else: an existing `.env` works as it is.

## [0.2.0]

### Added

- First start in the browser: on a fresh install `PUBLIC_URL` opens a setup page that creates the
  GitHub App in your organization with GitHub's manifest flow and shows its credentials once, as
  lines for `.env`. The server does not store them; on a laptop the page sets up a smee.io relay
  for webhooks.
- Owners of the GitHub organization can sign in before their account is linked in Slack; they
  reach the admin pages only, and their role changes are audited as `@login`.
- A **Getting started** checklist in Admin, computed from what is actually set up: Slack,
  linking your GitHub account, Telegram (optional), the config repo and a first notification.
- Connecting Slack and Telegram from the UI. Slack starts from a link that creates the app from
  its manifest; the Telegram dialog lists the groups the bot is in, with their ids.
- A [config repo template](https://github.com/callog-dev/notify-config-template), a button that
  creates `<org>/notify-config` from it and a "Load now" action.
- "Send test": a route's example goes through the normal pipeline and mentions you; afterwards
  the dialog shows the GitHub Action step for that route.
- Admin → Settings shows the tenant ID.

### Changed

- `ENCRYPTION_KEY` is required: the server exits with one line saying how to generate it.
- `ADMIN_TOKEN` is optional and only needed for scripted setup (`/admin/*`).
- Connecting Slack also verifies the app-level token (`xapp-…`), through the UI and
  `PUT /admin/tenants/:id/slack`; an error names the token Slack refused.
- README: the setup goes through the browser; registering the App by hand and scripted setup
  moved to [docs/setup.md](docs/setup.md).

### Operator actions

- If `ENCRYPTION_KEY` is not set, set it before upgrading (`openssl rand -base64 32`). An
  installation with Slack or Telegram connected already has it.
- Migrations `0011` and `0012` are applied at start. If your DBA applies migrations, also grant
  the server's role access to the new table `telegram_chats` (the `ALTER DEFAULT PRIVILEGES` from
  [docs/setup.md](docs/setup.md#5-migrations) covers it).
- An existing `.env` needs no other change.

## [0.1.2]

### Fixed

- The server no longer crashes on empty variables copied from `.env.example`
  (`DATABASE_URL_DIRECT=`, `DATABASE_SSL_CA_PATH=`, `ADMIN_TOKEN=`): an empty value means "not set".
- With the bundled Postgres, `DATABASE_URL` from `.env.example` no longer overrides the
  database address inside Docker (it pointed the container at its own `localhost`).
- An unreachable database, a wrong password or a missing database is reported as one line at
  start instead of a stack trace.

### Changed

- README: the GitHub App OAuth settings and `PUBLIC_URL` are part of the setup, the first
  sign-in goes through `/notify link github`, and the examples use your server URL.

### Operator actions

- If you copied `.env.example` for 0.1.0/0.1.1 and worked around these problems, nothing to do.

## [0.1.1]

### Fixed

- The image is published for `linux/amd64` and `linux/arm64`: it now runs on Apple Silicon and
  ARM servers (AWS Graviton and similar). 0.1.0 was amd64 only.

### Operator actions

- None.

## [0.1.0]

Initial release.

### Added

- Git-first routing: routes, templates (neutral blocks + Liquid, or raw Slack Block Kit), JSON
  Schema for `data` and teams as delivery addresses live in a config repo; every push is
  validated and loaded, an invalid config keeps the previous one active.
- Delivery to Slack and Telegram with mentions resolved to people, threads (`thread_key`, reply
  and edit), personal copies (`dm: true`) and per-person preferences.
- Identity mapping between GitHub, Slack and Telegram: Slack sync as the anchor, GitHub matching
  by verified domain emails and commit history, self-service linking with `/notify link`, manual
  links in the UI.
- Producers: a GitHub Action with OIDC (no secrets) and API keys for services; idempotent
  `POST /v1/notify`.
- `notify validate` / `preview` CLI and a config-repo Action with annotations and PR previews.
- Web UI: routes, personal settings, and `/manage` for admins (deliveries, people, teams
  coverage, admin roles with an audit log, API keys).
- Self-hosting: one Docker image + Postgres (bundled or your own, poolers, TLS, operator-applied
  migrations, start-up check — [docs/setup.md](docs/setup.md)); Prometheus metrics.

### Operator actions

- None.
