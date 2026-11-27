import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { DbExecutor } from "../db/db";
import { QueueService } from "../queue/queue.service";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import type { PlaceIssue } from "./channel";
import { ChannelRegistry } from "./channel-registry";

const CHECK_TASK = "places.check";

/**
 * Checks the places of a config with their messengers as soon as the config is loaded: a
 * room that does not exist shows up for the admin, not in the first notification.
 */
@Injectable()
export class PlaceChecks implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly configs: TenantConfigService,
    private readonly channels: ChannelRegistry,
  ) {}

  onModuleInit(): void {
    this.queue.register(CHECK_TASK, async (payload) => {
      const { retry } = await this.check((payload as { tenantId: string }).tenantId);
      // Failing the job is what makes the queue run it again, with a growing delay.
      if (retry) throw new Error("Some places could not be checked yet");
    });
    // On the queue, so that loading a config never waits for a messenger.
    this.configs.onActivated((tenantId, tx) => this.request(tenantId, tx));
  }

  async request(tenantId: string, executor?: DbExecutor): Promise<void> {
    await this.queue.enqueue(
      CHECK_TASK,
      { tenantId },
      { jobKey: `${CHECK_TASK}:${tenantId}`, maxAttempts: 8 },
      executor,
    );
  }

  /** Checks every place of the active config; `retry` when some answers are still due. */
  async check(tenantId: string): Promise<{ retry: boolean }> {
    const active = await this.configs.getActive(tenantId);
    if (!active) return { retry: false };
    const issues: Record<string, PlaceIssue> = {};
    let retry = false;
    for (const [name, place] of Object.entries(active.config.places)) {
      const [channel, room] =
        "slack" in place
          ? (["slack", place.slack] as const)
          : (["telegram", place.telegram] as const);
      const issue = await this.channels.get(channel)?.checkPlace?.(tenantId, room);
      if (!issue) continue;
      issues[name] = { level: issue.level, message: issue.message };
      retry ||= issue.transient === true;
    }
    await this.configs.setPlaceIssues(active.versionId, issues);
    return { retry };
  }
}
