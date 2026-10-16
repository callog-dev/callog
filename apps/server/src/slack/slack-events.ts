import { Injectable, type OnModuleInit } from "@nestjs/common";
import { QueueService } from "../queue/queue.service";
import { SlackUsersSync } from "./slack-users-sync";

const SYNC_TASK = "slack.sync";
/** user_change fires on every status or profile edit: sync at most once per this window. */
const THROTTLE_MS = 60_000;

@Injectable()
export class SlackEvents implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly usersSync: SlackUsersSync,
  ) {}

  onModuleInit(): void {
    this.queue.register(SYNC_TASK, async (payload) => {
      await this.usersSync.sync((payload as { tenantId: string }).tenantId);
    });
  }

  /**
   * Queues a full directory sync. `throttled` (Slack events) delays it and keeps the run
   * time of a sync already queued, so a burst of events costs one sync; an unthrottled
   * request (admin, hourly) runs now.
   */
  async requestSync(tenantId: string, { throttled = false } = {}): Promise<void> {
    await this.queue.enqueue(
      SYNC_TASK,
      { tenantId },
      {
        jobKey: `${SYNC_TASK}:${tenantId}`,
        maxAttempts: 5,
        ...(throttled
          ? { runAt: new Date(Date.now() + THROTTLE_MS), jobKeyMode: "preserve_run_at" as const }
          : {}),
      },
    );
  }
}
