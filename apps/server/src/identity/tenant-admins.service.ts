import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DB, type Db, type DbOrTx } from "../db/db";
import { auditLog, persons, tenantAdmins } from "../db/schema";

export type AdminRoleAction = "admin.granted" | "admin.revoked";

/**
 * The admin role granted inside the product. GitHub org owners are admins
 * without a row here; see `AdminCheck`. Every change is written to the audit log.
 */
@Injectable()
export class TenantAdminsService {
  private readonly logger = new Logger(TenantAdminsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async has(tenantId: string, personId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ personId: tenantAdmins.personId })
      .from(tenantAdmins)
      .where(and(eq(tenantAdmins.tenantId, tenantId), eq(tenantAdmins.personId, personId)));
    return row !== undefined;
  }

  async list(tenantId: string) {
    const grantedBy = alias(persons, "granted_by");
    return this.db
      .select({
        person: { id: persons.id, name: persons.displayName, status: persons.status },
        grantedBy: grantedBy.displayName,
        grantedAt: tenantAdmins.grantedAt,
      })
      .from(tenantAdmins)
      .innerJoin(persons, eq(persons.id, tenantAdmins.personId))
      .leftJoin(grantedBy, eq(grantedBy.id, tenantAdmins.grantedBy))
      .where(eq(tenantAdmins.tenantId, tenantId))
      .orderBy(persons.displayName);
  }

  /** Idempotent: granting an existing admin changes nothing and logs nothing. */
  async grant(tenantId: string, personId: string, actorId: string): Promise<boolean> {
    const rows = await this.db
      .insert(tenantAdmins)
      .values({ tenantId, personId, grantedBy: actorId })
      .onConflictDoNothing()
      .returning({ personId: tenantAdmins.personId });
    if (rows.length === 0) return false;
    await this.record(this.db, tenantId, "admin.granted", personId, actorId);
    return true;
  }

  async revoke(tenantId: string, personId: string, actorId: string): Promise<boolean> {
    return this.remove(this.db, tenantId, personId, actorId, undefined);
  }

  /** A person who left (inactive) keeps no role; runs with the deactivation. */
  async revokeOnDeactivation(executor: DbOrTx, tenantId: string, personId: string): Promise<void> {
    if (await this.remove(executor, tenantId, personId, null, { reason: "inactive" })) {
      this.logger.log(`Admin role of person ${personId} revoked: person is inactive`);
    }
  }

  async audit(tenantId: string, limit = 50) {
    const actor = alias(persons, "actor");
    const subject = alias(persons, "subject");
    return this.db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actor: actor.displayName,
        subject: subject.displayName,
        details: auditLog.details,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(actor, eq(actor.id, auditLog.actorPersonId))
      .leftJoin(subject, eq(subject.id, auditLog.subjectPersonId))
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }

  private async remove(
    executor: DbOrTx,
    tenantId: string,
    personId: string,
    actorId: string | null,
    details: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    const rows = await executor
      .delete(tenantAdmins)
      .where(and(eq(tenantAdmins.tenantId, tenantId), eq(tenantAdmins.personId, personId)))
      .returning({ personId: tenantAdmins.personId });
    if (rows.length === 0) return false;
    await this.record(executor, tenantId, "admin.revoked", personId, actorId, details);
    return true;
  }

  private async record(
    executor: DbOrTx,
    tenantId: string,
    action: AdminRoleAction,
    subjectPersonId: string,
    actorPersonId: string | null,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await executor
      .insert(auditLog)
      .values({ tenantId, action, subjectPersonId, actorPersonId, details: details ?? null });
  }
}
