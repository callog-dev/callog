import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import { tenants } from "../db/schema";

export type Tenant = typeof tenants.$inferSelect;

/** Convention when a tenant has not set `config_repo` explicitly. */
const DEFAULT_CONFIG_REPO_NAME = "notify-config";

export function configRepoOf(tenant: Tenant): { owner: string; repo: string } {
  const [owner, repo] = (
    tenant.configRepo ?? `${tenant.githubOrgLogin}/${DEFAULT_CONFIG_REPO_NAME}`
  ).split("/");
  return { owner: owner!, repo: repo! };
}

export type TenantActivatedListener = (tenant: Tenant) => Promise<void>;

export interface InstallationAccount {
  installationId: number;
  orgId: number;
  orgLogin: string;
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  private readonly activatedListeners: TenantActivatedListener[] = [];

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Lets other modules react to a new or reactivated tenant (e.g. load its config). */
  onActivated(listener: TenantActivatedListener): void {
    this.activatedListeners.push(listener);
  }

  /**
   * Creates the tenant for an installation, or reactivates it after an unsuspend or a
   * reinstall — a reinstall has a new installation id, so the org is matched by its id.
   */
  async activateInstallation({
    installationId,
    orgId,
    orgLogin,
  }: InstallationAccount): Promise<Tenant> {
    const values = {
      githubInstallationId: installationId,
      githubOrgId: orgId,
      githubOrgLogin: orgLogin,
      status: "active" as const,
    };
    const [previous] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.githubOrgId, orgId));
    const [tenant] = previous
      ? await this.db.update(tenants).set(values).where(eq(tenants.id, previous.id)).returning()
      : await this.db
          .insert(tenants)
          .values(values)
          .onConflictDoUpdate({ target: tenants.githubInstallationId, set: values })
          .returning();
    this.logger.log(
      `Tenant ${tenant!.id} active for org "${orgLogin}" (installation ${installationId})`,
    );
    for (const listener of this.activatedListeners) await listener(tenant!);
    return tenant!;
  }

  /** Data is kept: uninstalling must not destroy identities or history (retention still applies). */
  async deactivateInstallation(installationId: number): Promise<void> {
    const rows = await this.db
      .update(tenants)
      .set({ status: "inactive" })
      .where(eq(tenants.githubInstallationId, installationId))
      .returning({ id: tenants.id });
    if (rows.length > 0)
      this.logger.log(`Tenant ${rows[0]!.id} deactivated (installation ${installationId})`);
  }

  /** Marks tenants whose installation no longer exists as inactive. */
  async deactivateAllExcept(installationIds: number[]): Promise<void> {
    const rows = await this.db
      .update(tenants)
      .set({ status: "inactive" })
      .where(
        and(
          eq(tenants.status, "active"),
          isNotNull(tenants.githubInstallationId),
          installationIds.length > 0
            ? notInArray(tenants.githubInstallationId, installationIds)
            : undefined,
        ),
      )
      .returning({ id: tenants.id });
    for (const row of rows) this.logger.log(`Tenant ${row.id} deactivated (installation is gone)`);
  }

  async findById(id: string): Promise<Tenant | undefined> {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, id));
    return tenant;
  }

  /**
   * The active tenant of a GitHub org. The numeric org id decides when known: a login can
   * be renamed away and registered by another org. The login (case-insensitive) is only
   * a fallback for tenants whose org id is not recorded yet (reconcile fills it in).
   */
  async findActiveByOrg(orgLogin: string, orgId?: number): Promise<Tenant | undefined> {
    if (orgId !== undefined) {
      const [byId] = await this.db
        .select()
        .from(tenants)
        .where(and(eq(tenants.status, "active"), eq(tenants.githubOrgId, orgId)));
      if (byId) return byId;
    }
    const [byLogin] = await this.db
      .select()
      .from(tenants)
      .where(
        and(
          eq(tenants.status, "active"),
          sql`lower(${tenants.githubOrgLogin}) = ${orgLogin.toLowerCase()}`,
          orgId === undefined ? undefined : isNull(tenants.githubOrgId),
        ),
      )
      .orderBy(tenants.createdAt);
    return byLogin;
  }

  async listAll(): Promise<Tenant[]> {
    return this.db.select().from(tenants);
  }

  async listActive(): Promise<Tenant[]> {
    return this.db.select().from(tenants).where(eq(tenants.status, "active"));
  }

  async findByInstallation(installationId: number): Promise<Tenant | undefined> {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.githubInstallationId, installationId));
    return tenant;
  }
}
