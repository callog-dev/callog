import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from "@nestjs/common";
import type { InstallationEvent } from "@octokit/webhooks-types";
import { GithubAppService } from "../github/github-app.service";
import { GithubWebhooksService } from "../github/github-webhooks.service";
import { TenantsService } from "./tenants.service";

/** Keeps tenants in sync with GitHub App installations (tenant = installation). */
@Injectable()
export class InstallationEvents implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(InstallationEvents.name);

  constructor(
    private readonly webhooks: GithubWebhooksService,
    private readonly githubApp: GithubAppService,
    private readonly tenants: TenantsService,
  ) {}

  onModuleInit(): void {
    this.webhooks.on("installation", (payload) => this.handle(payload as InstallationEvent));
  }

  /** Catches up on installations whose webhooks were missed (e.g. server was down). */
  onApplicationBootstrap(): void {
    if (!this.githubApp.enabled) {
      this.logger.warn("GitHub App is not configured: tenants will not be synced");
      return;
    }
    void this.reconcile().catch((err: unknown) =>
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
  }

  private async handle(event: InstallationEvent): Promise<void> {
    const { installation } = event;
    const account = installation.account as { id: number; login: string; type: string };
    switch (event.action) {
      case "created":
      case "unsuspend":
      case "new_permissions_accepted":
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
