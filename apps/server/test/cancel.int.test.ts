import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { auditLog, deliveries, notifications, tenants } from "../src/db/schema";
import { DeliveryService, RetryLater } from "../src/delivery/delivery.service";
import { DELIVER_TASK, NotificationsService } from "../src/notifications/notifications.service";
import type { Producer } from "../src/producers/producer-auth.service";
import { SlackApiError } from "../src/slack/slack-api";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { activateConfig, createTenant, createTestApp } from "./setup/test-app";

const ROUTE = `
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }, { slack: "#fe" }]
template: [{ text: "Failed on {{ data.branch }}" }]`;

const ADMIN = { personId: null, githubLogin: "octocat" };
const BY_ADMIN = { type: "admin" as const, actor: "@octocat" };

describe("cancelling a notification (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let db: Db;
  let notificationsService: NotificationsService;
  let delivery: DeliveryService;
  let producer: Producer;

  beforeAll(async () => {
    ({ app, slack } = await createTestApp());
    db = app.get(DB);
    notificationsService = app.get(NotificationsService);
    delivery = app.get(DeliveryService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    await db.execute(sql`delete from graphile_worker._private_jobs`);
    slack.posted = [];
    slack.failures = [];
    slack.beforePost = undefined;
    slack.channels = [
      { id: "C0ALERTS1", name: "alerts" },
      { id: "C0FE00001", name: "fe" },
    ];
    const tenantId = await createTenant(app, 2600);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await activateConfig(app, tenantId, { "routes/r.yaml": ROUTE });
    producer = {
      tenantId,
      source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
      label: "ci",
    };
  });

  const accept = async () =>
    (
      await notificationsService.accept(producer, {
        route: "r",
        data: { branch: "main" },
        recipients: [],
        update: false,
      })
    ).notificationId;
  const notificationOf = async (id: string) =>
    (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;
  const statusesOf = async (id: string) =>
    (await db.select().from(deliveries).where(eq(deliveries.notificationId, id)))
      .map((d) => d.status)
      .sort();
  const jobs = async () =>
    (
      await db.execute(
        sql`select id from graphile_worker.jobs where task_identifier = ${DELIVER_TASK}`,
      )
    ).rows.length;

  it("stops a notification before its first attempt", async () => {
    const id = await accept();
    expect(await jobs()).toBe(1);

    await notificationsService.cancel(producer.tenantId, id, BY_ADMIN, ADMIN);

    const cancelled = await notificationOf(id);
    expect(cancelled).toMatchObject({ status: "cancelled", cancelledBy: BY_ADMIN });
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(await jobs()).toBe(0);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, producer.tenantId));
    expect(audit).toMatchObject({
      action: "notification.cancelled",
      actorGithubLogin: "octocat",
      details: { notificationId: id, deliveries: 0 },
    });

    expect(await delivery.deliver(id, { attempt: 1, maxAttempts: 8 })).toBe("cancelled");
    expect(slack.posted).toEqual([]);
    expect(await statusesOf(id)).toEqual([]);
  });

  it("stops the retries between attempts, keeping what was already sent", async () => {
    const id = await accept();
    slack.failures = [new SlackApiError("service_unavailable")];
    await expect(delivery.deliver(id, { attempt: 1, maxAttempts: 8 })).rejects.toThrow(RetryLater);
    expect(slack.posted).toHaveLength(1);

    await notificationsService.cancel(producer.tenantId, id, BY_ADMIN, ADMIN);

    expect(await statusesOf(id)).toEqual(["cancelled", "sent"]);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, producer.tenantId));
    expect(audit!.details).toEqual({ notificationId: id, deliveries: 1 });
    expect(await jobs()).toBe(0);

    expect(await delivery.deliver(id, { attempt: 2, maxAttempts: 8 })).toBe("cancelled");
    expect(slack.posted).toHaveLength(1);
    expect(await statusesOf(id)).toEqual(["cancelled", "sent"]);
  });

  it("lets a send already on its way land, and sends nothing after it", async () => {
    const id = await accept();
    slack.beforePost = async () => {
      slack.beforePost = undefined;
      await notificationsService.cancel(producer.tenantId, id, BY_ADMIN, ADMIN);
    };

    expect(await delivery.deliver(id, { attempt: 1, maxAttempts: 8 })).toBe("cancelled");

    expect(slack.posted).toHaveLength(1);
    expect(await statusesOf(id)).toEqual(["cancelled", "sent"]);
    expect(await notificationOf(id)).toMatchObject({ status: "cancelled", cancelledBy: BY_ADMIN });
  });

  it("keeps a delivery cancelled when its send fails after the cancellation", async () => {
    const id = await accept();
    slack.beforePost = async () => {
      slack.beforePost = undefined;
      await notificationsService.cancel(producer.tenantId, id, BY_ADMIN, ADMIN);
    };
    slack.failures = [new SlackApiError("service_unavailable")];

    expect(await delivery.deliver(id, { attempt: 8, maxAttempts: 8 })).toBe("cancelled");

    expect(slack.posted).toEqual([]);
    expect(await statusesOf(id)).toEqual(["cancelled", "cancelled"]);
    expect((await notificationOf(id)).status).toBe("cancelled");
  });

  it("refuses to cancel twice, or to cancel what was already delivered", async () => {
    const id = await accept();
    await notificationsService.cancel(producer.tenantId, id, BY_ADMIN, ADMIN);
    await expect(
      notificationsService.cancel(producer.tenantId, id, BY_ADMIN, ADMIN),
    ).rejects.toThrow("Nothing to cancel: the notification is cancelled");

    const delivered = await accept();
    expect(await delivery.deliver(delivered, { attempt: 1, maxAttempts: 8 })).toBe("delivered");
    await expect(
      notificationsService.cancel(producer.tenantId, delivered, BY_ADMIN, ADMIN),
    ).rejects.toThrow("Nothing to cancel: the notification is delivered");
    expect(await statusesOf(delivered)).toEqual(["sent", "sent"]);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.tenantId, producer.tenantId)),
    ).toHaveLength(1);
  });

  it("does not cancel another tenant's notification", async () => {
    const id = await accept();
    const other = await createTenant(app, 2601);
    await expect(notificationsService.cancel(other, id, BY_ADMIN, ADMIN)).rejects.toThrow(
      "Notification not found",
    );
    expect((await notificationOf(id)).status).toBe("accepted");
  });

  it("keeps a job that is already running from being retried", async () => {
    const id = await accept();
    await db.execute(
      sql`update graphile_worker._private_jobs set locked_at = now(), locked_by = 'worker-1'`,
    );

    await notificationsService.cancel(producer.tenantId, id, BY_ADMIN, ADMIN);

    const rows = await db.execute<{ key: string | null; attempts: number; max_attempts: number }>(
      sql`select key, attempts, max_attempts from graphile_worker.jobs
          where task_identifier = ${DELIVER_TASK}`,
    );
    expect(rows.rows).toEqual([{ key: null, attempts: 8, max_attempts: 8 }]);
  });
});
