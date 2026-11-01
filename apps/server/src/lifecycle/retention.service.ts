import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, lt, ne, notExists, notInArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import {
  configVersions,
  idempotencyKeys,
  linkTokens,
  notifications,
  persons,
  unmappedRecipients,
} from "../db/schema";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { TenantsService } from "../tenants/tenants.service";

/** Inactive people keep their accounts this long, in case the deactivation was a mistake. */
const INACTIVE_GRACE_DAYS = 30;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface RetentionReport {
  notifications: number;
  configVersions: number;
  unmappedRecipients: number;
  persons: number;
  idempotencyKeys: number;
  linkTokens: number;
}

export type TenantRetentionReport = Pick<
  RetentionReport,
  "notifications" | "configVersions" | "unmappedRecipients"
>;

/** Deletes data past its retention. Idempotent; safe to run any time. */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tenants: TenantsService,
    private readonly configs: TenantConfigService,
  ) {}

  async run(now = new Date()): Promise<RetentionReport> {
    const report: RetentionReport = {
      notifications: 0,
      configVersions: 0,
      unmappedRecipients: 0,
      persons: 0,
      idempotencyKeys: 0,
      linkTokens: 0,
    };

    // Inactive tenants (app uninstalled) keep their data, but not past retention.
    for (const tenant of await this.tenants.listAll()) {
      const part = await this.runTenant(tenant.id, now);
      report.notifications += part.notifications;
      report.configVersions += part.configVersions;
      report.unmappedRecipients += part.unmappedRecipients;
    }

    // Identities, preferences and link tokens of the person go with it (FK cascade).
    report.persons = (
      await this.db
        .delete(persons)
        .where(
          and(
            eq(persons.status, "inactive"),
            lt(persons.deactivatedAt, new Date(now.getTime() - INACTIVE_GRACE_DAYS * DAY_MS)),
          ),
        )
        .returning({ id: persons.id })
    ).length;

    report.idempotencyKeys = (
      await this.db
        .delete(idempotencyKeys)
        .where(lt(idempotencyKeys.expiresAt, now))
        .returning({ key: idempotencyKeys.key })
    ).length;

    report.linkTokens = (
      await this.db
        .delete(linkTokens)
        .where(lt(linkTokens.expiresAt, new Date(now.getTime() - DAY_MS)))
        .returning({ id: linkTokens.id })
    ).length;

    this.logger.log(`Retention: ${JSON.stringify(report)}`);
    return report;
  }

  /** The tenant's own data past its retention (people and tokens are cleaned up globally). */
  async runTenant(tenantId: string, now = new Date()): Promise<TenantRetentionReport> {
    const active = await this.configs.getActive(tenantId);
    const days = active?.config.config.retention_days ?? DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(now.getTime() - days * DAY_MS);

    // Deliveries and idempotency keys go with their notification (FK cascade). Unfinished
    // ones stay until the worker settles them (relevant for very short retention).
    const notificationsDeleted = await this.db
      .delete(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          lt(notifications.createdAt, cutoff),
          notInArray(notifications.status, ["accepted", "processing"]),
        ),
      );

    const configVersionsDeleted = await this.db.delete(configVersions).where(
      and(
        eq(configVersions.tenantId, tenantId),
        lt(configVersions.createdAt, cutoff),
        active ? ne(configVersions.id, active.versionId) : undefined,
        notExists(
          this.db
            .select({ one: sql`1` })
            .from(notifications)
            .where(eq(notifications.configVersionId, configVersions.id)),
        ),
      ),
    );

    const unmappedDeleted = await this.db
      .delete(unmappedRecipients)
      .where(
        and(eq(unmappedRecipients.tenantId, tenantId), lt(unmappedRecipients.lastSeenAt, cutoff)),
      );
    return {
      notifications: notificationsDeleted.rowCount ?? 0,
      configVersions: configVersionsDeleted.rowCount ?? 0,
      unmappedRecipients: unmappedDeleted.rowCount ?? 0,
    };
  }
}
