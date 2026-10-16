import { createPool } from "../../src/db/db";
import { runAllMigrations } from "../../src/db/migrate";
import { TEST_DATABASE_URL } from "./test-env";

/** Recreates the test database schema from scratch before the integration run. */
export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await pool.query(`
      drop schema if exists public cascade;
      drop schema if exists drizzle cascade;
      drop schema if exists graphile_worker cascade;
      create schema public;
    `);
    await runAllMigrations(pool);
  } finally {
    await pool.end();
  }
}
