import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { DbExecutor } from "../db/db";
import { QueueService } from "../queue/queue.service";
import { GithubIdentitySync } from "./github-identity-sync";

const GITHUB_SYNC_TASK = "github.identity_sync";

/**
 * Schedules GitHub identity sync whenever its inputs may have changed. The config is not
 * one of them: it holds no people.
 */
@Injectable()
export class IdentityEvents implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly githubSync: GithubIdentitySync,
  ) {}

  onModuleInit(): void {
    this.queue.register(GITHUB_SYNC_TASK, async (payload) => {
      await this.githubSync.sync((payload as { tenantId: string }).tenantId);
    });
  }

  /** Also called after a Slack sync: new work emails can match more GitHub accounts. */
  async requestGithubSync(tenantId: string, executor?: DbExecutor): Promise<void> {
    await this.queue.enqueue(
      GITHUB_SYNC_TASK,
      { tenantId },
      { jobKey: `${GITHUB_SYNC_TASK}:${tenantId}`, maxAttempts: 5 },
      executor,
    );
  }
}
