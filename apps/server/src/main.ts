import "reflect-metadata";
import { existsSync } from "node:fs";
import path from "node:path";
import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";
import { SecretBox } from "./crypto/secret-box";
import { createPool, poolOptions } from "./db/db";
import { runAllMigrations } from "./db/migrate";
import { checkDatabase, DatabasePreflightError } from "./db/preflight";

// Development convenience: the repo-root .env (absent in containers). Real env vars win.
const DOTENV = path.resolve(__dirname, "../../../.env");

async function bootstrap(): Promise<void> {
  if (existsSync(DOTENV)) process.loadEnvFile(DOTENV);
  const env = loadEnv();
  // Not generated on the fly: a key that lives only in the container would take every stored
  // Slack and Telegram token with it when the container is recreated.
  if (!env.ENCRYPTION_KEY) {
    console.error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`, put it into .env " +
        "and back it up together with the database: it encrypts Slack and Telegram tokens.",
    );
    process.exit(1);
  }
  try {
    new SecretBox(env.ENCRYPTION_KEY);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  // The database is checked and migrated before Nest starts: a misconfigured self-hosted
  // install fails here with one readable line (docs/setup.md).
  const pool = createPool(env.DATABASE_URL, poolOptions(env));
  try {
    await checkDatabase(pool, { migrateOnStart: env.MIGRATE_ON_START });
    if (env.MIGRATE_ON_START) await runAllMigrations(pool);
  } catch (err) {
    if (err instanceof DatabasePreflightError) {
      console.error(`Database check failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    await pool.end();
  }

  const levels: LogLevel[] = ["fatal", "error", "warn", "log", "debug", "verbose"];
  const logger = new ConsoleLogger({
    json: env.LOG_FORMAT === "json",
    colors: env.LOG_FORMAT === "pretty",
    logLevels: levels.slice(0, levels.indexOf(env.LOG_LEVEL) + 1),
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    // Webhook signatures are computed over the exact bytes received.
    rawBody: true,
    logger,
  });
  app.enableShutdownHooks();
  await app.listen(env.PORT, "0.0.0.0");
}

void bootstrap();
