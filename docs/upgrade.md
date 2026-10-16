# Upgrading a self-hosted installation

## 1. How releases work

- A release is a git tag `vX.Y.Z`. CI publishes the image `ghcr.io/callog-dev/callog` with
  the tags `X.Y.Z`, `X.Y` and `latest`, and a GitHub Release with notes from
  [CHANGELOG.md](../CHANGELOG.md) and an archive of the SQL migrations.
- **semver:**
  - **patch / minor** (`1.4.2 → 1.5.0`) — no action needed: `pull && up -d`;
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

## 3. Rolling back

Migrations only go forward and stay compatible with the previous release, so you can roll the
image back by **one** version and keep the database:

```bash
CALLOG_IMAGE=ghcr.io/callog-dev/callog:1.4.2
docker compose --profile app up -d
```

Going back further requires restoring the database backup taken before the upgrade.

## 4. Before upgrading

1. Read the version's section in [CHANGELOG.md](../CHANGELOG.md) (and below, for a major).
2. Back up the database (a snapshot for managed databases; `pg_dump` for the bundled one, see
   [setup.md](setup.md#2-bundled-postgres-or-your-own)).
3. Within one major version you can skip versions; across majors, upgrade one major at a time.

## 5. Version-specific steps

Only versions that need manual steps are listed here. None so far.
