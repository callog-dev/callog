import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, type Db } from "../src/db/db";
import { deliveries, notifications, tenants, unmappedRecipients } from "../src/db/schema";
import { DeliveryService, RetryLater } from "../src/delivery/delivery.service";
import { PeopleService } from "../src/identity/people.service";
import { RecipientResolver } from "../src/routing/recipient-resolver";
import { SlackApiError } from "../src/slack/slack-api";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { createTestApp, eventually, createTenant, activateConfig } from "./setup/test-app";

const CONFIG = (route: string) => ({
  "teams.yaml": `
teams:
  fe: { slack_channel: "#fe" }
  tg: { telegram_chat: tg-chat }`,
  "routes/r.yaml": route,
});

const ROUTE = `
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }, { team: fe }]
template:
  - text: "Failed on {{ data.branch }} by {{ recipients | mention }}"`;

describe("delivery (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let db: Db;
  let service: DeliveryService;
  let tenantId: string;
  let versionId: string;

  beforeAll(async () => {
    ({ app, slack } = await createTestApp());
    db = app.get(DB);
    service = app.get(DeliveryService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const setup = async (route = ROUTE) => {
    await db.delete(tenants);
    slack.posted = [];
    slack.failures = [];
    slack.channels = [
      { id: "C0ALERTS1", name: "alerts" },
      { id: "C0FE00001", name: "fe" },
    ];
    tenantId = await createTenant(app, 800);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await app.get(PeopleService).linkAccounts(tenantId, {
      displayName: "bob",
      accounts: [
        { provider: "slack", externalId: "UBOB", source: "sync", confidence: "verified" },
        {
          provider: "github",
          externalId: "2",
          handle: "bob",
          source: "oauth",
          confidence: "verified",
        },
      ],
    });
    versionId = (await activateConfig(app, tenantId, CONFIG(route))).id;
  };

  const createNotification = async (recipients = ["github:bob", "github:ghost"]) => {
    const [n] = await db
      .insert(notifications)
      .values({
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        data: { branch: "main" },
        recipients,
      })
      .returning();
    return n!.id;
  };

  const rowsOf = (id: string) =>
    db.select().from(deliveries).where(eq(deliveries.notificationId, id));
  const statusOf = async (id: string) =>
    (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!.status;

  beforeEach(async () => {
    await setup();
  });

  it("renders with mentions, sends to every destination and records the outcome", async () => {
    const id = await createNotification();

    expect(await service.deliver(id, { attempt: 1, maxAttempts: 8 })).toBe("delivered");

    expect(slack.posted.map((p) => p.channel).sort()).toEqual(["C0ALERTS1", "C0FE00001"]);
    expect(slack.posted[0]!.message.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Failed on main by <@UBOB>, ghost" } },
    ]);
    const rows = await rowsOf(id);
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(rows[0]!.providerMessageRef).toMatchObject({
      provider: "slack",
      ts: expect.any(String),
    });
    const unmapped = await db.select().from(unmappedRecipients);
    expect(unmapped).toEqual([expect.objectContaining({ ref: "github:ghost", occurrences: 1 })]);
  });

  it("retries only what failed transiently and never re-sends delivered messages", async () => {
    const id = await createNotification();
    slack.failures = [new SlackApiError("service_unavailable")];

    await expect(service.deliver(id, { attempt: 1, maxAttempts: 8 })).rejects.toThrow(RetryLater);
    expect(await statusOf(id)).toBe("processing");
    expect(slack.posted).toHaveLength(1);

    expect(await service.deliver(id, { attempt: 2, maxAttempts: 8 })).toBe("delivered");
    expect(slack.posted).toHaveLength(2);
    expect((await rowsOf(id)).map((r) => r.attempts).sort()).toEqual([1, 2]);
    // Unmapped recipients were counted once, not per attempt.
    expect((await db.select().from(unmappedRecipients))[0]!.occurrences).toBe(1);
  });

  it("fails permanently on non-retryable Slack errors", async () => {
    const id = await createNotification();
    slack.failures = [new SlackApiError("channel_not_found")];

    expect(await service.deliver(id, { attempt: 1, maxAttempts: 8 })).toBe("partially_failed");
    const failed = (await rowsOf(id)).find((r) => r.status === "failed");
    expect(failed?.lastError).toBe("slack: channel_not_found");
  });

  it("gives up after the last attempt", async () => {
    const id = await createNotification();
    slack.failures = [new SlackApiError("internal_error"), new SlackApiError("internal_error")];

    expect(await service.deliver(id, { attempt: 8, maxAttempts: 8 })).toBe("failed");
    expect((await rowsOf(id)).every((r) => r.status === "failed")).toBe(true);
  });

  it("settles the notification when the last attempt fails outside a delivery", async () => {
    const id = await createNotification();
    const resolve = vi
      .spyOn(app.get(RecipientResolver), "resolve")
      .mockRejectedValue(new Error("connection terminated"));
    try {
      await expect(service.deliver(id, { attempt: 1, maxAttempts: 8 })).rejects.toThrow(
        "connection terminated",
      );
      expect(await service.deliver(id, { attempt: 8, maxAttempts: 8 })).toBe("failed");
    } finally {
      resolve.mockRestore();
    }
    expect(await statusOf(id)).toBe("failed");
  });

  it("waits out a short rate limit inside the job", async () => {
    const id = await createNotification();
    slack.failures = [new SlackApiError("ratelimited", 1)];
    const started = Date.now();

    expect(await service.deliver(id, { attempt: 1, maxAttempts: 8 })).toBe("delivered");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it("fails Telegram deliveries permanently when Telegram is not connected", async () => {
    await setup(`
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }, { team: tg }]
template: [{ text: hi }]`);
    const id = await createNotification([]);

    expect(await service.deliver(id, { attempt: 1, maxAttempts: 8 })).toBe("partially_failed");
    const tg = (await rowsOf(id)).find((r) => r.provider === "telegram");
    expect(tg).toMatchObject({
      status: "failed",
      lastError: "telegram: Telegram is not connected for this tenant",
    });
  });

  it("fails on template errors without calling Slack", async () => {
    await setup(`
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }]
template: [{ buttons: [{ text: Go, url: "{{ data.branch }}" }] }]`);
    const id = await createNotification([]);

    expect(await service.deliver(id, { attempt: 1, maxAttempts: 8 })).toBe("failed");
    expect(slack.posted).toEqual([]);
    expect((await rowsOf(id))[0]!.lastError).toContain("Template error");
  });

  it("is a no-op for finished notifications", async () => {
    const id = await createNotification();
    await service.deliver(id, { attempt: 1, maxAttempts: 8 });
    await service.deliver(id, { attempt: 1, maxAttempts: 8 });
    expect(slack.posted).toHaveLength(2);
  });
});

describe("delivery through the queue (integration)", () => {
  it("delivers a notification accepted by the API", async () => {
    const { app, slack, adminRequest } = await createTestApp({ role: "all" });
    try {
      const db = app.get(DB);
      await db.delete(tenants);
      const [tenant] = await db
        .insert(tenants)
        .values({ githubInstallationId: 801, githubOrgLogin: "acme" })
        .returning();
      await app.get(SlackConnectionsService).connect(tenant!.id, GOOD_SLACK_TOKEN);
      await activateConfig(app, tenant!.id, CONFIG(ROUTE));
      slack.channels = [
        { id: "C0ALERTS1", name: "alerts" },
        { id: "C0FE00001", name: "fe" },
      ];
      const { key } = (
        await adminRequest("POST", `/admin/tenants/${tenant!.id}/api-keys`, { name: "ci" })
      ).json();

      const res = await app.inject({
        method: "POST",
        url: "/v1/notify",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: JSON.stringify({ route: "r", data: { branch: "main" } }),
      });
      const id = res.json().notification_id;

      const status = await eventually<{ deliveries: { status: string }[] }>(async () => {
        const s = await app.inject({
          method: "GET",
          url: `/v1/notifications/${id}`,
          headers: { authorization: `Bearer ${key}` },
        });
        return s.json().status === "delivered" ? s.json() : undefined;
      });
      expect(status.deliveries).toHaveLength(2);
      expect(status.deliveries.every((d) => d.status === "sent")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
