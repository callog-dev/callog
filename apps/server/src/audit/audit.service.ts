import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db, type DbOrTx } from "../db/db";
import { auditLog } from "../db/schema";

/** Who acted: a person, an org owner not linked to one yet, or (both null) the system. */
export interface AuditActor {
  personId: string | null;
  githubLogin: string | null;
}

export interface AuditEntry {
  tenantId: string;
  action: string;
  actor: AuditActor;
  subjectPersonId?: string;
  details?: Record<string, unknown>;
}

/** The tenant's audit log: what admins (and the system on their behalf) changed. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Pass `executor` to record within the transaction that made the change. */
  async record(entry: AuditEntry, executor: DbOrTx = this.db): Promise<void> {
    await executor.insert(auditLog).values({
      tenantId: entry.tenantId,
      action: entry.action,
      subjectPersonId: entry.subjectPersonId ?? null,
      actorPersonId: entry.actor.personId,
      actorGithubLogin: entry.actor.personId ? null : entry.actor.githubLogin,
      details: entry.details ?? null,
    });
  }

  /** When each action last happened and its details, e.g. a maintenance task's last run. */
  async latest(tenantId: string, actions: readonly string[]) {
    const rows = await this.db
      .selectDistinctOn([auditLog.action], {
        action: auditLog.action,
        at: auditLog.createdAt,
        details: auditLog.details,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), inArray(auditLog.action, [...actions])))
      .orderBy(auditLog.action, desc(auditLog.createdAt));
    return new Map(rows.map(({ action, ...run }) => [action, run]));
  }
}
