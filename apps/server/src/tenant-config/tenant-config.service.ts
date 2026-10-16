import { Inject, Injectable } from "@nestjs/common";
import type { Config, ConfigIssue } from "@callog/config-schema";
import { and, desc, eq } from "drizzle-orm";
import { DB, type Db, type Tx } from "../db/db";
import { configVersions } from "../db/schema";

export interface ActiveConfig {
  versionId: string;
  commitSha: string;
  config: Config;
}

export type ConfigVersion = typeof configVersions.$inferSelect;

/** Runs in the transaction that records the version: if it fails, nothing is recorded. */
export type ConfigActivatedListener = (tenantId: string, tx: Tx) => Promise<void>;

/** Stores loaded config versions and serves the active one (last-known-good). */
@Injectable()
export class TenantConfigService {
  private readonly activatedListeners: ConfigActivatedListener[] = [];

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Called after a new valid config version becomes active. */
  onActivated(listener: ConfigActivatedListener): void {
    this.activatedListeners.push(listener);
  }

  async getActive(tenantId: string): Promise<ActiveConfig | undefined> {
    const [version] = await this.db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.tenantId, tenantId), eq(configVersions.status, "valid")))
      .orderBy(desc(configVersions.createdAt))
      .limit(1);
    return version && toActive(version);
  }

  /** A specific version, e.g. the one a notification was accepted under. */
  async getVersion(versionId: string): Promise<ActiveConfig | undefined> {
    const [version] = await this.db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.id, versionId), eq(configVersions.status, "valid")));
    return version && toActive(version);
  }

  async latest(tenantId: string): Promise<ConfigVersion | undefined> {
    const [version] = await this.db
      .select()
      .from(configVersions)
      .where(eq(configVersions.tenantId, tenantId))
      .orderBy(desc(configVersions.createdAt))
      .limit(1);
    return version;
  }

  /**
   * Records an active version. Listeners run in the same transaction: a failed one fails
   * the load, and its retry records the version again instead of seeing it as unchanged.
   */
  async recordValid(tenantId: string, commitSha: string, config: Config, warnings: ConfigIssue[]) {
    return this.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(configVersions)
        .values({
          tenantId,
          commitSha,
          status: "valid",
          config,
          errors: warnings.length > 0 ? { warnings } : null,
        })
        .returning();
      for (const listener of this.activatedListeners) await listener(tenantId, tx);
      return version!;
    });
  }

  async recordInvalid(
    tenantId: string,
    commitSha: string,
    errors: ConfigIssue[],
    warnings: ConfigIssue[],
  ) {
    const [version] = await this.db
      .insert(configVersions)
      .values({ tenantId, commitSha, status: "invalid", errors: { errors, warnings } })
      .returning();
    return version!;
  }
}

function toActive(version: ConfigVersion): ActiveConfig {
  return { versionId: version.id, commitSha: version.commitSha, config: version.config as Config };
}
