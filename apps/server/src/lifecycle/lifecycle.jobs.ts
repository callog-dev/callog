import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { OrganizationEvent } from "@octokit/webhooks-types";
import { GithubWebhooksService } from "../github/github-webhooks.service";
import { IdentityEvents } from "../identity/identity-events";
import { PeopleService } from "../identity/people.service";
import { QueueService } from "../queue/queue.service";
import { SlackEvents } from "../slack/slack-events";
import { TenantsService } from "../tenants/tenants.service";
import { RetentionService } from "./retention.service";

const SYNC_ALL_TASK = "lifecycle.sync_all";
const RETENTION_TASK = "retention.cleanup";

/**
 * Keeps people current without relying only on events: an hourly sync of
 * every tenant, a daily retention run, and GitHub org membership events.
 */
@Injectable()
export class LifecycleJobs implements OnModuleInit {
  private readonly logger = new Logger(LifecycleJobs.name);

  constructor(
    private readonly queue: QueueService,
    private readonly tenants: TenantsService,
    private readonly slackEvents: SlackEvents,
    private readonly identityEvents: IdentityEvents,
    private readonly people: PeopleService,
    private readonly retention: RetentionService,
    private readonly webhooks: GithubWebhooksService,
  ) {}

  onModuleInit(): void {
    this.queue.register(SYNC_ALL_TASK, () => this.syncAll());
    this.queue.register(RETENTION_TASK, async () => {
      await this.retention.run();
    });
    this.queue.schedule(SYNC_ALL_TASK, "0 * * * *");
    this.queue.schedule(RETENTION_TASK, "17 3 * * *");
    this.webhooks.on("organization", (payload) =>
      this.onOrganization(payload as OrganizationEvent),
    );
  }

  /** Fans out to per-tenant jobs, so one broken workspace does not block the others. */
  async syncAll(): Promise<void> {
    for (const tenant of await this.tenants.listActive()) {
      await this.slackEvents.requestSync(tenant.id);
      await this.identityEvents.requestGithubSync(tenant.id);
    }
  }

  /**
   * Someone left the GitHub org: their GitHub account no longer represents them here.
   * Being active is decided by Slack (the anchor), so the person stays as they are.
   */
  private async onOrganization(event: OrganizationEvent): Promise<void> {
    if (event.action !== "member_removed" || !event.installation) return;
    const tenant = await this.tenants.findByInstallation(event.installation.id);
    const user = event.membership?.user;
    if (!tenant || !user) return;
    if (await this.people.removeIdentity(tenant.id, "github", String(user.id))) {
      this.logger.log(`Unlinked github:${user.login} (removed from ${tenant.githubOrgLogin})`);
    }
  }
}
