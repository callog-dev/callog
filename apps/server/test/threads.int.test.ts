import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { deliveries, notifications, tenants } from "../src/db/schema";
import { DeliveryService, RetryLater } from "../src/delivery/delivery.service";
import { SlackApiError } from "../src/slack/slack-api";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { TelegramConnectionsService } from "../src/telegram/telegram-connections.service";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { GOOD_TELEGRAM_TOKEN, type FakeTelegram } from "./setup/fake-telegram";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const GROUP = "-100999";

describe("threads (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let telegram: FakeTelegram;
  let db: Db;
  let tenantId: string;
  let versionId: string;

  beforeAll(async () => {
    ({ app, slack, telegram } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    slack.posted = [];
    slack.updated = [];
    slack.deletedTs.clear();
    telegram.sent = [];
    telegram.edited = [];
    tenantId = await createTenant(app, 1200);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
    versionId = (
      await activateConfig(app, tenantId, {
        "routes/r.yaml": `
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }, { telegram: "${GROUP}" }]
template: [{ text: "e2e {{ data.state }}" }]`,
      })
    ).id;
  });

  const accept = async (state: string, threadKey?: string, update = false) => {
    const [n] = await db
      .insert(notifications)
      .values({
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        data: { state },
        threadKey,
        update,
      })
      .returning();
    return n!.id;
  };
  const deliver = (id: string) =>
    app.get(DeliveryService).deliver(id, { attempt: 1, maxAttempts: 8 });

  /** Accepts and delivers one notification, like the API + worker would. */
  const send = async (state: string, threadKey?: string, update = false) => {
    const id = await accept(state, threadKey, update);
    expect(await deliver(id)).toBe("delivered");
    return db.select().from(deliveries).where(eq(deliveries.notificationId, id));
  };

  it("posts the first message, replies in its thread, then edits it", async () => {
    await send("🟡 running", "e2e/main/1");
    await send("2 tests failed", "e2e/main/1");
    const edited = await send("🔴 failed", "e2e/main/1", true);

    const root = slack.posted[0]!;
    expect(root.message.threadTs).toBeUndefined();
    expect(slack.posted[1]!.message).toMatchObject({
      threadTs: root.ts,
      text: "e2e 2 tests failed",
    });
    expect(slack.posted).toHaveLength(2);
    expect(slack.updated).toEqual([
      {
        channel: "C0ALERTS1",
        ts: root.ts,
        message: expect.objectContaining({ text: "e2e 🔴 failed" }),
      },
    ]);

    expect(telegram.sent[0]!.options?.replyToMessageId).toBeUndefined();
    expect(telegram.sent[1]!.options?.replyToMessageId).toBe(1);
    expect(telegram.edited).toEqual([
      { chatId: GROUP, messageId: 1, message: expect.objectContaining({ text: "e2e 🔴 failed" }) },
    ]);

    // An edit points at the root message it changed.
    expect(edited.find((d) => d.provider === "slack")!.providerMessageRef).toEqual({
      provider: "slack",
      channel: "C0ALERTS1",
      ts: root.ts,
    });
  });

  it("keeps different threads and messages without a thread apart", async () => {
    await send("a", "t1");
    await send("b", "t2");
    await send("c");
    await send("d");
    expect(slack.posted.every((p) => p.message.threadTs === undefined)).toBe(true);
    expect(telegram.sent.every((s) => s.options?.replyToMessageId === undefined)).toBe(true);
  });

  it("posts a new message when asked to update a thread that has none yet", async () => {
    await send("🟢 fixed", "fresh", true);
    expect(slack.posted).toHaveLength(1);
    expect(slack.updated).toEqual([]);
    expect(telegram.edited).toEqual([]);
  });

  it("posts a new message when the root was deleted in Slack", async () => {
    await send("🟡 running", "gone");
    slack.deletedTs.add(slack.posted[0]!.ts!);

    await send("🔴 failed", "gone", true);

    expect(slack.updated).toEqual([]);
    expect(slack.posted).toHaveLength(2);
    expect(slack.posted[1]!.message.threadTs).toBeUndefined();
  });

  it("holds a reply back while the thread's earlier notification is still retrying", async () => {
    const root = await accept("🟡 running", "retry");
    const reply = await accept("2 tests failed", "retry");
    // The root's Slack post fails transiently; the queue runs the reply during its backoff.
    slack.failures = [new SlackApiError("service_unavailable")];
    await expect(deliver(root)).rejects.toThrow(RetryLater);
    await expect(deliver(reply)).rejects.toThrow(RetryLater);
    expect(slack.posted).toHaveLength(0);

    expect(await deliver(root)).toBe("delivered");
    expect(await deliver(reply)).toBe("delivered");
    expect(slack.posted.map((p) => p.message.threadTs)).toEqual([undefined, slack.posted[0]!.ts]);
  });
});
