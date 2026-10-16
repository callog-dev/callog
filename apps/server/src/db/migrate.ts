import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runMigrations as runQueueMigrations } from "graphile-worker";
import type { Pool } from "pg";
import { createDb } from "./db";

// Same relative location from src/db (tests) and dist/db (build).
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

/**
 * Applies app schema (Drizzle) and queue schema (graphile-worker) migrations. `queue: false`
 * leaves the queue schema to the worker, which migrates it itself on start: with a DBA-owned
 * app schema the queue schema must belong to the app role (docs/setup.md, "Migrations").
 */
export async function runAllMigrations(pool: Pool, options: { queue?: boolean } = {}) {
  await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  if (options.queue ?? true) await runQueueMigrations({ pgPool: pool });
}
