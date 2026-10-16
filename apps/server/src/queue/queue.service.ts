import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { CronItem, Task } from "graphile-worker";
import { DB, type Db, type DbExecutor } from "../db/db";

export interface EnqueueOptions {
  /** Jobs sharing a queue name run strictly one after another. */
  queueName?: string;
  jobKey?: string;
  maxAttempts?: number;
  runAt?: Date;
  /** What an existing job with the same key keeps (graphile-worker; default `replace`). */
  jobKeyMode?: "replace" | "preserve_run_at";
}

@Injectable()
export class QueueService {
  private readonly tasks = new Map<string, Task>();
  private readonly cron: CronItem[] = [];

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Modules register their handlers in `onModuleInit`; the worker starts after that. */
  register(name: string, task: Task): void {
    if (this.tasks.has(name)) {
      throw new Error(`Task "${name}" is already registered`);
    }
    this.tasks.set(name, task);
  }

  /**
   * Schedules a registered task on a cron pattern (UTC). graphile-worker makes sure each
   * tick runs once even with several worker processes; missed ticks are not backfilled.
   */
  schedule(task: string, match: string): void {
    this.cron.push({
      task,
      match,
      identifier: task,
      options: { backfillPeriod: 0, maxAttempts: 3 },
    });
  }

  cronItems(): CronItem[] {
    return [...this.cron];
  }

  taskList(): Record<string, Task> {
    return Object.fromEntries(this.tasks);
  }

  /**
   * Adds a job via SQL so it can share a transaction with the caller's writes:
   * pass `tx` to enqueue atomically with them.
   */
  async enqueue(
    task: string,
    payload: unknown,
    options: EnqueueOptions = {},
    executor: DbExecutor = this.db,
  ): Promise<void> {
    await executor.execute(sql`
      select graphile_worker.add_job(
        identifier => ${task},
        payload => ${JSON.stringify(payload)}::json,
        queue_name => ${options.queueName ?? null},
        run_at => ${options.runAt?.toISOString() ?? null}::timestamptz,
        max_attempts => ${options.maxAttempts ?? null}::int,
        job_key => ${options.jobKey ?? null},
        job_key_mode => ${options.jobKeyMode ?? null}
      )
    `);
  }
}
