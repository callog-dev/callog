import { UnprocessableEntityException } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asc, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { notifications, tenants } from "../src/db/schema";
import { DeliveryService } from "../src/delivery/delivery.service";
import { NotificationsService } from "../src/notifications/notifications.service";
import { parseNotifyRequest } from "../src/notifications/notify-request";
import type { Producer } from "../src/producers/producer-auth.service";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const ROUTE = `
id: alert
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }]
group: { key: "{{ data.alert }}", window: 15m }
template: [{ text: "{{ data.alert }} is {{ data.state }}" }]`;

describe("grouping repeats (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let db: Db;
  let producer: Producer;

  beforeAll(async () => {
    ({ app, slack } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    slack.posted = [];
    slack.updated = [];
    const tenantId = await createTenant(app, 2200);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await activateConfig(app, tenantId, { "routes/alert.yaml": ROUTE });
    producer = {
      tenantId,
      source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
      label: "ci",
    };
  });

  /** Accepts and delivers one notification, like the API + worker would. */
  const send = async (data: Record<string, unknown>, threadKey?: string) => {
    const { notificationId } = await app.get(NotificationsService).accept(producer, {
      route: "alert",
      data,
      recipients: [],
      thread_key: threadKey,
      update: false,
    });
    expect(
      await app.get(DeliveryService).deliver(notificationId, { attempt: 1, maxAttempts: 8 }),
    ).toBe("delivered");
  };
  const stored = () =>
    db
      .select({
        threadKey: notifications.threadKey,
        update: notifications.update,
      })
      .from(notifications)
      .orderBy(asc(notifications.createdAt));

  it("edits the first message when the same thing repeats, counting the repeats", async () => {
    await send({ alert: "cpu", state: "high" });
    await send({ alert: "cpu", state: "higher" });
    await send({ alert: "cpu", state: "on fire" });

    expect(slack.posted.map((p) => p.message.text)).toEqual(["cpu is high"]);
    expect(slack.updated.map((u) => u.message.text)).toEqual(["cpu is higher", "cpu is on fire"]);
    expect(slack.updated[1]!.message.blocks!.at(-1)).toMatchObject({
      type: "context",
      elements: [{ text: expect.stringMatching(/^Repeated 3 times, last at \d\d:\d\d UTC$/) }],
    });
    const rows = await stored();
    expect(rows.map((r) => r.update)).toEqual([false, true, true]);
    expect(new Set(rows.map((r) => r.threadKey)).size).toBe(1);
  });

  it("keeps different keys apart", async () => {
    await send({ alert: "cpu", state: "high" });
    await send({ alert: "disk", state: "full" });

    expect(slack.posted.map((p) => p.message.text)).toEqual(["cpu is high", "disk is full"]);
    expect(slack.updated).toEqual([]);
  });

  it("opens a new group once the window after the first message is over", async () => {
    await send({ alert: "cpu", state: "high" });
    await db.update(notifications).set({ createdAt: sql`now() - interval '16 minutes'` });
    await send({ alert: "cpu", state: "high again" });

    expect(slack.posted.map((p) => p.message.text)).toEqual(["cpu is high", "cpu is high again"]);
    expect(new Set((await stored()).map((r) => r.threadKey)).size).toBe(2);
    expect(slack.updated).toEqual([]);
  });

  it("opens one group for repeats that arrive together", async () => {
    const accept = (state: string) =>
      app.get(NotificationsService).accept(producer, {
        route: "alert",
        data: { alert: "cpu", state },
        recipients: [],
        update: false,
      });
    await Promise.all(["a", "b", "c", "d"].map(accept));

    const rows = await stored();
    expect(new Set(rows.map((r) => r.threadKey)).size).toBe(1);
    expect(rows.filter((r) => !r.update)).toHaveLength(1);
  });

  it("does not let a sender name a group thread", () => {
    const request = { route: "alert", thread_key: "group:alert:x:1", update: true };
    expect(() => parseNotifyRequest(request)).toThrow(UnprocessableEntityException);
    expect(parseNotifyRequest({ ...request, thread_key: "groups" }).thread_key).toBe("groups");
  });

  it("does not group a key that renders to nothing, or a sender that names a thread", async () => {
    await send({ state: "unknown" });
    await send({ state: "unknown" });
    await send({ alert: "cpu", state: "high" }, "mine");
    await send({ alert: "cpu", state: "high" }, "mine");

    expect(slack.updated).toEqual([]);
    expect((await stored()).map((r) => r.threadKey)).toEqual([null, null, "mine", "mine"]);
  });
});
