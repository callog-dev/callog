# Changelog

All notable changes to Callog. The format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/): a **minor** release is `docker compose pull && up -d`,
a **major** release needs the steps in [docs/upgrade.md](docs/upgrade.md). Every release has an
**Operator actions** section, even when it says "none".

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
