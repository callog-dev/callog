import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from "@nestjs/common";
import type { PushEvent } from "@octokit/webhooks-types";
import { GithubAppService } from "../github/github-app.service";
import { GithubWebhooksService } from "../github/github-webhooks.service";
import { QueueService } from "../queue/queue.service";
import { configRepoOf, TenantsService } from "../tenants/tenants.service";
import { ConfigLoader } from "./config-loader";

const LOAD_TASK = "config.load";

/** Decides when a tenant's config must be (re)loaded and schedules it on the queue. */
@Injectable()
export class ConfigEvents implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ConfigEvents.name);

  constructor(
    private readonly queue: QueueService,
    private readonly webhooks: GithubWebhooksService,
    private readonly githubApp: GithubAppService,
    private readonly tenants: TenantsService,
    private readonly loader: ConfigLoader,
  ) {}

  onModuleInit(): void {
    this.queue.register(LOAD_TASK, async (payload) => {
      await this.loader.load((payload as { tenantId: string }).tenantId);
    });
    this.webhooks.on("push", (payload) => this.handlePush(payload as PushEvent));
    this.tenants.onActivated((tenant) => this.requestReload(tenant.id));
  }

  /** Catches up on pushes missed while the server was down. */
  onApplicationBootstrap(): void {
    if (!this.githubApp.enabled) return;
    void (async () => {
      for (const tenant of await this.tenants.listActive()) await this.requestReload(tenant.id);
    })().catch((err: unknown) => this.logger.error(`Startup config reload failed: ${String(err)}`));
  }

  async requestReload(tenantId: string): Promise<void> {
    await this.queue.enqueue(
      LOAD_TASK,
      { tenantId },
      {
        // One pending load per tenant: bursts of pushes collapse into a single load of HEAD.
        jobKey: `${LOAD_TASK}:${tenantId}`,
        queueName: `config:${tenantId}`,
        maxAttempts: 5,
      },
    );
  }

  private async handlePush(event: PushEvent): Promise<void> {
    const installationId = event.installation?.id;
    if (!installationId) return;
    const tenant = await this.tenants.findByInstallation(installationId);
    if (!tenant || tenant.status !== "active") return;

    const { owner, repo } = configRepoOf(tenant);
    const pushedRepo = event.repository.full_name.toLowerCase();
    const isConfigRepo = pushedRepo === `${owner}/${repo}`.toLowerCase();
    const isDefaultBranch = event.ref === `refs/heads/${event.repository.default_branch}`;
    if (isConfigRepo && isDefaultBranch) await this.requestReload(tenant.id);
  }
}
