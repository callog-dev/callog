import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "../config/env";
import { createPool, poolOptions } from "./db";
import { runAllMigrations } from "./migrate";
import { checkDatabase, DatabasePreflightError } from "./preflight";

const DOTENV = path.resolve(__dirname, "../../../../.env");

/**
 * `node dist/db/migrate.cli.js [--app-only]`: applies migrations by hand (MIGRATE_ON_START=false).
 * `--app-only` skips the queue schema, which the app role owns and migrates itself.
 */
async function main(): Promise<void> {
  if (existsSync(DOTENV)) process.loadEnvFile(DOTENV);
  const env = loadEnv();
  const appOnly = process.argv.includes("--app-only");
  const pool = createPool(env.DATABASE_URL, poolOptions(env));
  try {
    await checkDatabase(pool, { migrateOnStart: true, queue: !appOnly });
    await runAllMigrations(pool, { queue: !appOnly });
    console.log(appOnly ? "App schema migrations applied" : "Migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof DatabasePreflightError ? err.message : err);
  process.exit(1);
});
