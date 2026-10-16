import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplicationContext } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigModule } from "../src/config/config.module";
import { DB, type Db } from "../src/db/db";
import { DbModule } from "../src/db/db.module";
import { tenants } from "../src/db/schema";
import { QueueModule } from "../src/queue/queue.module";
import { QueueService } from "../src/queue/queue.service";
import { TEST_DATABASE_URL } from "./setup/test-env";

describe("queue (integration)", () => {
  let app: INestApplicationContext;
  let db: Db;
  let queue: QueueService;
  const received: unknown[] = [];
  const waiters: Array<() => void> = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.ROLE = "all";
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DbModule, QueueModule],
    }).compile();
    app = moduleRef;
    db = app.get(DB);
    queue = app.get(QueueService);
    queue.register("test.ping", async (payload) => {
      received.push(payload);
      waiters.shift()?.();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const nextJob = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("job was not executed in time")), 10_000);
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  it("executes an enqueued job", async () => {
    const done = nextJob();
    await queue.enqueue("test.ping", { n: 1 });
    await done;
    expect(received).toContainEqual({ n: 1 });
  });

  it("enqueues atomically with the caller's transaction", async () => {
    const countJobs = async () => {
      const res = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from graphile_worker.jobs where task_identifier = 'test.never'`,
      );
      return res.rows[0]?.count;
    };

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(tenants).values({ githubOrgLogin: "rollback-org" });
        await queue.enqueue("test.never", {}, { runAt: new Date(Date.now() + 3_600_000) }, tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await countJobs()).toBe(0);
    const orgs = await db
      .select()
      .from(tenants)
      .where(sql`github_org_login = 'rollback-org'`);
    expect(orgs).toHaveLength(0);
  });

  it("runs jobs of the same queue in order", async () => {
    received.length = 0;
    const all = Promise.all([nextJob(), nextJob(), nextJob()]);
    for (const n of [1, 2, 3]) {
      await queue.enqueue("test.ping", { n }, { queueName: "thread:test" });
    }
    await all;
    expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});
