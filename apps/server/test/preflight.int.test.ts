import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, looksLikePooler } from "../src/db/db";
import { checkDatabase, DatabasePreflightError, pendingMigrations } from "../src/db/preflight";
import { TEST_DATABASE_URL } from "./setup/test-env";

/** A fresh, never-migrated database and a role without DDL rights in it. */
const FRESH_DB = "notify_preflight";
const RO_ROLE = "notify_preflight_ro";

const urlFor = (database: string, user?: string) => {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = user;
  }
  return url.toString();
};

describe("database pre-flight (integration)", () => {
  const admin = createPool(TEST_DATABASE_URL);

  beforeAll(async () => {
    await admin.query(`drop database if exists ${FRESH_DB}`);
    await admin.query(`drop role if exists ${RO_ROLE}`);
    await admin.query(`create database ${FRESH_DB}`);
    await admin.query(`create role ${RO_ROLE} login password '${RO_ROLE}'`);
    // PG 14 still grants CREATE on public to everyone; take it away to model a DML-only role.
    const fresh = createPool(urlFor(FRESH_DB));
    await fresh.query(`revoke create on schema public from public`);
    await fresh.end();
  });

  afterAll(async () => {
    await admin.query(`drop database if exists ${FRESH_DB} with (force)`);
    await admin.query(`drop role if exists ${RO_ROLE}`);
    await admin.end();
  });

  it("passes on a migrated database whatever MIGRATE_ON_START says", async () => {
    expect(await pendingMigrations(admin)).toBe(0);
    for (const migrateOnStart of [true, false]) {
      expect(await checkDatabase(admin, { migrateOnStart })).toMatchObject({ pending: 0 });
    }
  });

  it("refuses to start on pending migrations when the operator applies them", async () => {
    const pool = createPool(urlFor(FRESH_DB));
    try {
      const err = await checkDatabase(pool, { migrateOnStart: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DatabasePreflightError);
      expect((err as Error).message).toMatch(
        /^\d+ database migration\(s\) are pending and MIGRATE_ON_START=false/,
      );
      // The owner can migrate it itself.
      await expect(checkDatabase(pool, { migrateOnStart: true })).resolves.toMatchObject({
        pending: expect.any(Number),
      });
    } finally {
      await pool.end();
    }
  });

  it("walks a DML-only role through the queue schema and the pending migrations", async () => {
    const pool = createPool(urlFor(FRESH_DB, RO_ROLE));
    const fresh = createPool(urlFor(FRESH_DB));
    const failure = async () => {
      const err = await checkDatabase(pool, { migrateOnStart: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DatabasePreflightError);
      expect((err as Error).message).toContain("See docs/setup.md");
      return (err as Error).message;
    };
    try {
      // 1. The queue installs its own schema: the role needs CREATE on the database.
      expect(await failure()).toContain(`GRANT CREATE ON DATABASE "${FRESH_DB}" TO "${RO_ROLE}"`);
      // 2. A queue schema owned by someone else is unusable (RLS on its tables).
      await fresh.query(`create schema graphile_worker`);
      expect(await failure()).toContain(`is owned by "${new URL(TEST_DATABASE_URL).username}"`);
      await fresh.query(`drop schema graphile_worker`);
      // 3. With CREATE on the database, what is left are the app migrations it cannot run.
      await fresh.query(`grant create on database ${FRESH_DB} to ${RO_ROLE}`);
      expect(await failure()).toContain(`role "${RO_ROLE}" cannot run them`);
      // The DBA's own run skips the queue schema it does not own.
      await expect(
        checkDatabase(fresh, { migrateOnStart: true, queue: false }),
      ).resolves.toMatchObject({ pending: expect.any(Number) });
    } finally {
      await pool.end();
      await fresh.end();
    }
  });
});

describe("looksLikePooler", () => {
  it.each([
    ["postgres://u:p@db.internal:6432/notify", true],
    ["postgres://u:p@aws-0-eu.pooler.supabase.com:5432/postgres", true],
    ["postgres://u:p@pgbouncer:5432/notify", true],
    ["postgres://u:p@db:5432/notify?pgbouncer=true", true],
    ["postgres://u:p@db.internal:5432/notify", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(looksLikePooler(url)).toBe(expected);
  });
});
