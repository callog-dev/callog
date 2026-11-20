import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from "@nestjs/common";
import type { InstallationEvent, OrganizationEvent } from "@octokit/webhooks-types";
import { accessGaps, describeGaps, hasGaps } from "../github/app-access";
import { AppAccessService } from "../github/app-access.service";
import { GithubAppService } from "../github/github-app.service";
import { GithubWebhooksService } from "../github/github-webhooks.service";
import { TenantsService } from "./tenants.service";

/** Keeps tenants in sync with GitHub App installations (tenant = installation) and org renames. */
@Injectable()
export class InstallationEvents implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(InstallationEvents.name);

  constructor(
    private readonly webhooks: GithubWebhooksService,
    private readonly githubApp: GithubAppService,
    private readonly access: AppAccessService,
    private readonly tenants: TenantsService,
  ) {}

  onModuleInit(): void {
    this.webhooks.on("installation", (payload) => this.handle(payload as InstallationEvent));
    this.webhooks.on("organization", (payload) =>
      this.onOrganization(payload as OrganizationEvent),
    );
  }

  onApplicationBootstrap(): void {
    if (!this.githubApp.enabled) {
      this.logger.warn("GitHub App is not configured: tenants will not be synced");
      return;
    }
    void this.reconcileIfEnabled();
  }

  /**
   * Catches up on installation and rename webhooks that were missed (e.g. server was down).
   * Never throws: a failure is logged and the next run retries.
   */
  async reconcileIfEnabled(): Promise<void> {
    if (!this.githubApp.enabled) return;
    await this.reconcile().catch((err: unknown) =>
      this.logger.error(`Installation reconcile failed: ${String(err)}`),
    );
  }

  async reconcile(): Promise<void> {
    const installations = await this.githubApp.listInstallations();
    const active = installations.filter((i) => i.accountType === "Organization" && !i.suspended);
    for (const installation of active) {
      await this.tenants.activateInstallation({
        installationId: installation.id,
        orgId: installation.accountId,
        orgLogin: installation.accountLogin,
      });
    }
    await this.tenants.deactivateAllExcept(active.map((i) => i.id));
    this.access.forget();
    // An App registered by hand: nothing else says what it lacks until a sync or a sign-in fails.
    if (active.length === 0) {
      this.logger.warn("The GitHub App is not installed on any organization");
    }
    for (const installation of active) {
      const gaps = accessGaps(installation.access);
      if (hasGaps(gaps)) {
        this.logger.warn(`Installation on ${installation.accountLogin}: ${describeGaps(gaps)}`);
      }
    }
  }

  private async onOrganization(event: OrganizationEvent): Promise<void> {
    if (event.action !== "renamed" || !event.installation) return;
    await this.tenants.renameOrg({
      installationId: event.installation.id,
      orgId: event.organization.id,
      orgLogin: event.organization.login,
    });
  }

  private async handle(event: InstallationEvent): Promise<void> {
    const { installation } = event;
    const account = installation.account as { id: number; login: string; type: string };
    switch (event.action) {
      case "created":
      case "unsuspend":
      case "new_permissions_accepted":
        this.access.forget();
        if (account.type !== "Organization") {
          this.logger.warn(`Ignoring installation ${installation.id} on a ${account.type} account`);
          return;
        }
        await this.tenants.activateInstallation({
          installationId: installation.id,
          orgId: account.id,
          orgLogin: account.login,
        });
        return;
      case "deleted":
      case "suspend":
        await this.tenants.deactivateInstallation(installation.id);
        return;
    }
  }
}
