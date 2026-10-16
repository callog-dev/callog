import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DB, type Db } from "../db/db";

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Liveness: the process is up. */
  @Get("healthz")
  healthz(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: the database answers. */
  @Get("readyz")
  async readyz(): Promise<{ status: "ok" }> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ok" };
    } catch {
      throw new ServiceUnavailableException("database is not reachable");
    }
  }
}
