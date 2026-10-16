import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { setBounded } from "../common/bounded-map";
import { DB, type Db } from "../db/db";
import { identities, persons, USABLE_CONFIDENCE } from "../db/schema";
import { GithubAppService } from "../github/github-app.service";
import { TenantAdminsService } from "../identity/tenant-admins.service";
import { TenantsService } from "../tenants/tenants.service";

/** Org roles change rarely; every admin request (and `/api/me`) needs one. */
const ORG_ROLE_CACHE_MS = 60_000;
const MAX_ORG_OWNERS = 10_000;

/** Admins = owners of the GitHub org + the role granted in /manage. */
@Injectable()
export class AdminCheck {
  private readonly logger = new Logger(AdminCheck.name);
  /** `<tenant>:<login>` → org owner or not. */
  private readonly orgOwners = new Map<string, { at: number; owner: boolean }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tenants: TenantsService,
    private readonly githubApp: GithubAppService,
    private readonly admins: TenantAdminsService,
  ) {}

  async isAdmin(tenantId: string, personId: string): Promise<boolean> {
    return (await this.admins.has(tenantId, personId)) || this.isOrgOwner(tenantId, personId);
  }

  /** Owners cannot be demoted here: the role is GitHub's. */
  async isOrgOwner(tenantId: string, personId: string): Promise<boolean> {
    const accounts = await this.db
      .select({
        provider: identities.provider,
        externalId: identities.externalId,
        handle: identities.handle,
      })
      .from(identities)
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.personId, personId),
          // A suggested link is unconfirmed: it must not grant admin.
          inArray(identities.confidence, [...USABLE_CONFIDENCE]),
        ),
      );

    const login = accounts.find((a) => a.provider === "github" && a.handle)?.handle;
    if (!login || !this.githubApp.enabled) return false;
    const key = `${tenantId}:${login}`;
    const cached = this.orgOwners.get(key);
    if (cached && Date.now() - cached.at < ORG_ROLE_CACHE_MS) return cached.owner;
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant?.githubInstallationId) return false;
    try {
      const octokit = await this.githubApp.installationOctokit(tenant.githubInstallationId);
      const { data } = await octokit.request("GET /orgs/{org}/memberships/{username}", {
        org: tenant.githubOrgLogin,
        username: login,
      });
      return this.remember(key, data.role === "admin" && data.state === "active");
    } catch (err) {
      if ((err as { status?: number }).status === 404) return this.remember(key, false);
      // GitHub is unavailable: keep the last known answer rather than locking owners out.
      this.logger.warn(`Org role check failed: ${String(err)}`);
      return cached?.owner ?? false;
    }
  }

  /** Org owners by login, with the person each one is linked to (if any). */
  async listOrgOwners(
    tenantId: string,
  ): Promise<{ login: string; person: { id: string; name: string } | null }[]> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant?.githubInstallationId || !this.githubApp.enabled) return [];
    const logins: string[] = [];
    try {
      const octokit = await this.githubApp.installationOctokit(tenant.githubInstallationId);
      for (let page = 1; ; page++) {
        const { data } = await octokit.request("GET /orgs/{org}/members", {
          org: tenant.githubOrgLogin,
          role: "admin",
          per_page: 100,
          page,
        });
        logins.push(...data.map((m) => m.login));
        if (data.length < 100) break;
      }
    } catch (err) {
      this.logger.warn(`Listing org owners failed: ${String(err)}`);
      return [];
    }
    if (logins.length === 0) return [];
    const linked = await this.db
      .select({ handle: identities.handle, id: persons.id, name: persons.displayName })
      .from(identities)
      .innerJoin(persons, eq(persons.id, identities.personId))
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.provider, "github"),
          inArray(
            identities.handle,
            logins.map((l) => l.toLowerCase()),
          ),
          inArray(identities.confidence, [...USABLE_CONFIDENCE]),
        ),
      );
    return logins.map((login) => {
      const p = linked.find((l) => l.handle === login.toLowerCase());
      return { login, person: p ? { id: p.id, name: p.name } : null };
    });
  }

  private remember(key: string, owner: boolean): boolean {
    setBounded(this.orgOwners, key, { at: Date.now(), owner }, MAX_ORG_OWNERS);
    return owner;
  }
}
