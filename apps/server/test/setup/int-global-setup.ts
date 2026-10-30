import { escapeIdentifier } from "pg";
import { createPool } from "../../src/db/db";
import { runAllMigrations } from "../../src/db/migrate";
import { TEST_DATABASE_URL } from "./test-env";

/** Recreates the test database schema from scratch before the integration run. */
export default async function setup(): Promise<void> {
  await ensureDatabase(TEST_DATABASE_URL);
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

/** Creates the test database on the first run, so a fresh Postgres needs no init script. */
async function ensureDatabase(url: string): Promise<void> {
  const server = new URL(url);
  const name = decodeURIComponent(server.pathname.slice(1));
  server.pathname = "/postgres";
  const pool = createPool(server.toString());
  try {
    // Checked first: CREATE DATABASE needs CREATEDB even when the database already exists.
    const { rowCount } = await pool.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) await pool.query(`create database ${escapeIdentifier(name)}`);
  } catch (err) {
    if ((err as { code?: string }).code === "42501") {
      throw new Error(`Cannot create database "${name}": create it or set TEST_DATABASE_URL.`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    await pool.end();
  }
}
