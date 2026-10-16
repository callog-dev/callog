import { readFileSync } from "node:fs";
import { Logger } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Env } from "../config/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** Anything that can run SQL: the db itself or a transaction. */
export type DbExecutor = Pick<Db, "execute">;
/** A transaction handle (`db.transaction(async (tx) => …)`). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The database or a transaction: methods that may run inside the caller's transaction. */
export type DbOrTx = Db | Tx;

export const DB = Symbol("DB");
export const DB_POOL = Symbol("DB_POOL");
/**
 * Pool the queue worker listens on. graphile-worker needs a real session (LISTEN/NOTIFY),
 * which a transaction-mode pooler such as PgBouncer does not provide — `DATABASE_URL_DIRECT`
 * bypasses it. Same object as DB_POOL when no direct URL is set.
 */
export const QUEUE_POOL = Symbol("QUEUE_POOL");

export interface PoolOptions {
  /** CA certificate (PEM) to verify the server with; TLS is then required. */
  sslCa?: string;
}

export function createPool(databaseUrl: string, options: PoolOptions = {}): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    ...(options.sslCa ? { ssl: { ca: options.sslCa, rejectUnauthorized: true } } : {}),
  });
  // Without listeners an idle-client error (e.g. Postgres restart) crashes the process.
  const logger = new Logger("DbPool");
  const logError = (err: Error) => logger.error(err.message, err.stack);
  pool.on("error", logError);
  pool.on("connect", (client) => client.on("error", logError));
  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

/** Pool options from the environment: the CA either inline or from a file. */
export function poolOptions(env: Pick<Env, "DATABASE_SSL_CA" | "DATABASE_SSL_CA_PATH">) {
  const sslCa =
    env.DATABASE_SSL_CA ??
    (env.DATABASE_SSL_CA_PATH ? readFileSync(env.DATABASE_SSL_CA_PATH, "utf8") : undefined);
  return { sslCa };
}

/** Heuristic: the URL points at a connection pooler rather than at Postgres itself. */
export function looksLikePooler(databaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  return (
    url.port === "6432" ||
    url.hostname.includes("pooler") ||
    url.hostname.includes("pgbouncer") ||
    url.searchParams.get("pgbouncer") === "true"
  );
}
