import { Controller, Post, UseGuards } from "@nestjs/common";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { LifecycleJobs } from "./lifecycle.jobs";
import { RetentionService, type RetentionReport } from "./retention.service";

@Controller("admin")
@UseGuards(AdminTokenGuard)
export class AdminLifecycleController {
  constructor(
    private readonly retention: RetentionService,
    private readonly jobs: LifecycleJobs,
  ) {}

  /** Runs retention now instead of waiting for the daily job. */
  @Post("retention/run")
  run(): Promise<RetentionReport> {
    return this.retention.run();
  }

  /** Queues Slack and GitHub syncs for every tenant, like the hourly job. */
  @Post("sync/all")
  async syncAll(): Promise<{ queued: true }> {
    await this.jobs.syncAll();
    return { queued: true };
  }
}
