import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { parseCronItems, run, type Runner } from "graphile-worker";
import type { Pool } from "pg";
import { ENV, type Env } from "../config/env";
import { QUEUE_POOL } from "../db/db";
import { QueueService } from "./queue.service";

@Injectable()
export class QueueWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QueueWorker.name);
  private runner: Runner | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(QUEUE_POOL) private readonly pool: Pool,
    private readonly queue: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.ROLE === "api") return;
    const taskList = this.queue.taskList();
    this.runner = await run({
      pgPool: this.pool,
      taskList,
      parsedCronItems: parseCronItems(this.queue.cronItems()),
      concurrency: 5,
      noHandleSignals: true,
    });
    this.logger.log(`Worker started with tasks: ${Object.keys(taskList).join(", ")}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runner?.stop();
  }
}
