# Changelog

All notable changes to Callog. The format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/): a **minor** release is a regular upgrade
(`docker compose pull && up -d`, or `helm upgrade`), a **major** release needs the steps in
[docs/upgrade.md](docs/upgrade.md). Every release has an
**Operator actions** section, even when it says "none".

## [0.5.0]

### Added

- Places: `places.yaml` gives rooms a name (`deploys: { slack: "#deploys" }`). A route delivers
  to `place: <name>`, and a sender can add `place:<name>` to `recipients` to post there too —
  without knowing which messenger or channel is behind the name.
- Hooks: an admin binds a token to one route, and any JSON object posted with it becomes the
  notification's `data`. A sender that can set a header posts to `/v1/hooks` with
  `Authorization: Bearer <token>`; one that cannot posts to `/v1/hooks/<token>`. The token is
  shown once; a hook is revoked by name. A route only hooks post to needs no
  `allowed_sources`.
- The Getting started checklist has an optional step for alert sources.
- The Helm chart has `sendersIngress`: a public host that serves only the sender API under
  `/v1/`, for senders outside the cluster.
- Presets: ready-made routes for systems that send their own webhooks, in
  `templates/presets`. The first one is for Grafana Alerting.
- `mandatory: true` on a route: people cannot mute it, and a mute they set earlier does not
  hold.
- `urgency` on a notification (`low`, `normal`, `high`) and on a route (`default` and `max`).
  It is recorded and checked against the route, and nothing acts on it yet.
- A route can add recipients on its own with `recipients`: Liquid templates over `data` that
  render to people, teams or places (`github:{{ data.commit.author }}`). What does not render
  to a recipient is left out, so a webhook payload never fails the request.
- A built-in `direct` route: plain text (`data.text`) to the people and places in
  `recipients`, without a route in the config. People get it as a personal message. Only API
  keys created with `direct` may use it.
- Grouping: a route with `group: { key, window }` turns repeats of the same thing — an alert
  that keeps firing — into edits of one message, with a line saying how many times it
  repeated. `key` is a Liquid template over `data`; a group stays open for `window` (up to
  24h) after its first notification.
- A route without `destinations` names a `default_place`: where a notification is posted when
  it reaches nobody else — its recipients name no place and get no personal copy.

- A personal copy that cannot be delivered — the messenger refuses it, or the attempts run
  out — is sent another way: in the person's other messenger, then in the room of the team
  they were named through, then in the route's `default_place`, with a line saying whom the
  post is for. People with no account in any messenger start at the room; a team with nobody
  to write to is posted to its room.
- A delivery trace. Admins see what happened on the way to each recipient: whom each delivery
  is for, which delivery took over a failed one, who was left out and why (muted the route,
  no account in any messenger, unknown, a team with nobody to write to), and whether the
  notification joined a group. `GET /v1/notifications/<id>` tells a sender which of the
  recipients it named led nowhere and which delivery took over a failed one — nothing about
  the people themselves.
- In the web UI: a route's page says when a place is only its fallback, when the route adds
  recipients from the data, and when it groups repeats.
- In the web UI: a notification's page traces its deliveries — whom each is for, what took
  over a refused one, who was left out and why; Settings → Hooks creates and revokes hooks;
  Places lists the rooms behind each name with the routes that use them; an API key can be
  created with direct messages allowed.
- Recipients of a route with personal copies who have no account in any messenger show up
  among the unmapped recipients.

### Changed

- Muting a route now also stops its mentions. A Slack user group with a member who muted the
  route is mentioned member by member, without that person.
- Retrying a notification leaves alone the deliveries that another one took over.
- **Breaking:** a route describes its message with `template` only. The `slack_blocks` key is
  gone, and the `buttons` block is now `actions`.
- Every channel shows every block: a block a channel cannot draw is sent as text in that
  channel's formatting.
- A mention in a `header` or in the text of an action is written as the person's name.

### Operator actions

- Change the config repo before upgrading the server; the steps are in
  [docs/upgrade.md](docs/upgrade.md#050).
- Database migrations add the `hooks` table and columns to `notifications`, `api_keys` and
  `deliveries`; they run on
  start unless `MIGRATE_ON_START=false`.
- `direct` is now a reserved route id: rename a route of yours that has it.
- Recipients that start with `oncall:` are refused: the prefix is kept for a later release.
- `thread_key` values that start with `group:` are refused: those threads belong to grouping.
- A hook's token is part of its URL. Keep request paths under `/v1/hooks/` out of access logs
  of the proxy in front of Callog, and make that path reachable from the systems that send.
- In the config repo, rename `buttons:` to `actions:` in route templates and rewrite routes
  that use `slack_blocks` with `template` blocks. `notify validate` reports both.

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
