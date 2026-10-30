# Upgrading a self-hosted installation

## 1. How releases work

- A release is a git tag `vX.Y.Z`. CI publishes the image `ghcr.io/callog-dev/callog` with
  the tags `X.Y.Z`, `X.Y` and `latest`, and a GitHub Release with notes from
  [CHANGELOG.md](../CHANGELOG.md) and an archive of the SQL migrations.
- **semver:**
  - **patch / minor** (`1.4.2 → 1.5.0`) — no action beyond a [regular upgrade](#2-regular-upgrade)
    (`pull && up -d`, or `helm upgrade`);
  - **major** (`1.x → 2.0`) — read the version's section below before upgrading.
- Every release in the CHANGELOG has an **Operator actions** section, even when it says "none".
- A new required service (should one ever appear) only arrives in a major version, and only
  after a release in which it was optional.

## 2. Regular upgrade

Pin the version in `.env`, so that upgrades are explicit and can be rolled back:

```bash
CALLOG_IMAGE=ghcr.io/callog-dev/callog:1.5.0
```

```bash
docker compose --profile app pull
docker compose --profile app up -d
docker compose logs -f app   # migrations, then "Nest application successfully started"
```

The server applies migrations itself at start. If your DBA applies them
(`MIGRATE_ON_START=false`), do the step from [setup.md → Migrations](setup.md#5-migrations) first,
then `up -d`.

Avoid the `latest` tag in production: any `pull` would upgrade.

**With Helm**, the chart version is the release version:

```bash
helm upgrade callog oci://ghcr.io/callog-dev/charts/callog --version 1.5.0 -n callog -f values.yaml
```

The worker's init container applies the migrations before the new worker starts; api pods restart
until they are applied.

## 3. Rolling back

Migrations only go forward and stay compatible with the previous release, so you can roll the
image back by **one** version and keep the database:

```bash
CALLOG_IMAGE=ghcr.io/callog-dev/callog:1.4.2
docker compose --profile app up -d
```

With Helm: `helm rollback callog -n callog` (the previous revision).

Going back further requires restoring the database backup taken before the upgrade.

## 4. Before upgrading

1. Read the version's section in [CHANGELOG.md](../CHANGELOG.md) (and below, for a major).
2. Back up the database (a snapshot for managed databases; `pg_dump` for the bundled one, see
   [setup.md](setup.md#2-bundled-postgres-or-your-own)).
3. Within one major version you can skip versions; across majors, upgrade one major at a time.

## 5. Version-specific steps

Only versions that need manual steps are listed here.

### 0.2.0

- `ENCRYPTION_KEY` becomes required. If `.env` does not have it, add one
  (`openssl rand -base64 32`) before `up -d`, otherwise the server exits with a one-line hint.
  An installation that has Slack or Telegram connected already has it.
- With `MIGRATE_ON_START=false`, grant the server's role access to the new `telegram_chats`
  table after applying the migrations (see [setup.md → Migrations](setup.md#5-migrations)).
