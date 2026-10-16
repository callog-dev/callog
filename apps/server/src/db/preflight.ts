import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

/** Oldest Postgres the server runs on (docs/setup.md). */
export const MIN_PG_VERSION = 14;

const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

export class DatabasePreflightError extends Error {
  constructor(message: string) {
    super(`${message} See docs/setup.md.`);
    this.name = "DatabasePreflightError";
  }
}

/**
 * What the database must look like before the server starts, checked up front so that a
 * self-hosted install fails with one readable line instead of a stack trace from the first
 * query: a supported version and, when migrations are pending, either the rights to
 * apply them or MIGRATE_ON_START=true.
 */
export async function checkDatabase(
  pool: Pool,
  options: {
    migrateOnStart: boolean;
    /** Check the queue schema too (off for `migrate.cli --app-only`, run by the DBA role). */
    queue?: boolean;
  },
) {
  const { rows } = await pool.query<{
    version: string;
    schemaCreate: boolean;
    dbCreate: boolean;
    user: string;
    bypassRls: boolean;
    queueOwner: string | null;
    queueInstalled: boolean;
    database: string;
  }>(`select current_setting('server_version_num') as version,
             has_schema_privilege(current_user, 'public', 'CREATE') as "schemaCreate",
             has_database_privilege(current_user, current_database(), 'CREATE') as "dbCreate",
             current_user as "user",
             (select rolsuper or rolbypassrls from pg_roles where rolname = current_user)
               as "bypassRls",
             (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'graphile_worker')
               as "queueOwner",
             exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'graphile_worker' and c.relname = 'migrations')
               as "queueInstalled",
             current_database() as database`);
  const info = rows[0]!;
  const major = Math.floor(Number(info.version) / 10_000);
  if (major < MIN_PG_VERSION) {
    throw new DatabasePreflightError(
      `PostgreSQL ${major} is not supported: ${MIN_PG_VERSION} or newer is required.`,
    );
  }
  if (options.queue ?? true) checkQueueSchema(info);
  const pending = await pendingMigrations(pool);
  if (pending === 0) return { version: major, pending };
  if (!options.migrateOnStart) {
    throw new DatabasePreflightError(
      `${pending} database migration(s) are pending and MIGRATE_ON_START=false. ` +
        "Run `node dist/db/migrate.cli.js` as the schema owner (add `--app-only` when the queue " +
        "schema belongs to the app role) or apply the SQL from drizzle/, then start again.",
    );
  }
  if (!(info.schemaCreate && info.dbCreate)) {
    throw new DatabasePreflightError(
      `${pending} database migration(s) are pending, but role "${info.user}" cannot run them ` +
        "(needs CREATE on the database and on schema public). Make it the database owner, or " +
        "apply the migrations with a privileged role (migrate.cli.js --app-only) and start " +
        "with MIGRATE_ON_START=false.",
    );
  }
  return { version: major, pending };
}

/**
 * graphile-worker enables row-level security on its tables without policies, so only their
 * owner can use them, and it installs its schema with `create schema if not exists`, which
 * needs CREATE on the database. The role the server runs as must therefore own the queue
 * schema, and be able to create it on the first start (docs/setup.md, "Migrations").
 */
function checkQueueSchema(info: {
  user: string;
  database: string;
  dbCreate: boolean;
  bypassRls: boolean;
  queueOwner: string | null;
  queueInstalled: boolean;
}): void {
  if (info.bypassRls) return;
  if (info.queueOwner !== null && info.queueOwner !== info.user) {
    throw new DatabasePreflightError(
      `The queue schema "graphile_worker" is owned by "${info.queueOwner}", but the server runs ` +
        `as "${info.user}"; the queue's tables are only usable by their owner. Drop it ` +
        `(DROP SCHEMA graphile_worker CASCADE;) and let "${info.user}" create it on start.`,
    );
  }
  if (!info.queueInstalled && !info.dbCreate) {
    throw new DatabasePreflightError(
      `Role "${info.user}" cannot create the queue schema on first start: ` +
        `GRANT CREATE ON DATABASE "${info.database}" TO "${info.user}"; ` +
        "(this allows new schemas only, not tables in public).",
    );
  }
}

/** Migrations in the bundled journal that the database has not recorded. */
export async function pendingMigrations(pool: Pool): Promise<number> {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  const { rows } = await pool
    .query<{ applied: string }>(
      `select count(*)::text as applied from drizzle.__drizzle_migrations`,
    )
    .catch((err: { code?: string }) => {
      // 42P01 undefined_table: never migrated.
      if (err.code === "42P01" || err.code === "3F000") return { rows: [{ applied: "0" }] };
      throw err;
    });
  return Math.max(0, journal.entries.length - Number(rows[0]!.applied));
}
