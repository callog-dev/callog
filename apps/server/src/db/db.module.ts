import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { Pool } from "pg";
import { ENV, type Env } from "../config/env";
import { createDb, createPool, DB, DB_POOL, looksLikePooler, poolOptions, QUEUE_POOL } from "./db";

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [ENV],
      useFactory: (env: Env) => createPool(env.DATABASE_URL, poolOptions(env)),
    },
    { provide: DB, inject: [DB_POOL], useFactory: (pool: Pool) => createDb(pool) },
    {
      provide: QUEUE_POOL,
      inject: [ENV, DB_POOL],
      useFactory: (env: Env, pool: Pool) => {
        if (env.DATABASE_URL_DIRECT) return createPool(env.DATABASE_URL_DIRECT, poolOptions(env));
        if (env.ROLE !== "api" && looksLikePooler(env.DATABASE_URL)) {
          new Logger("DbModule").warn(
            "DATABASE_URL looks like a connection pooler; the queue worker needs a direct " +
              "connection for LISTEN/NOTIFY or it only polls — set DATABASE_URL_DIRECT (docs/setup.md)",
          );
        }
        return pool;
      },
    },
  ],
  exports: [DB, DB_POOL, QUEUE_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(QUEUE_POOL) private readonly queuePool: Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.queuePool !== this.pool) await this.queuePool.end();
    await this.pool.end();
  }
}
