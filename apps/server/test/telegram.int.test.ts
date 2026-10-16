import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { parseConfigTree } from "@callog/config-schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, type Db } from "../src/db/db";
import { deliveries, notifications, telegramConnections, tenants } from "../src/db/schema";
import { DeliveryService, RetryLater } from "../src/delivery/delivery.service";
import { PeopleService } from "../src/identity/people.service";
import { TelegramApiError } from "../src/telegram/telegram-api";
import { TelegramConnectionsService } from "../src/telegram/telegram-connections.service";
import { TelegramPoller } from "../src/telegram/telegram-poller";
import { TelegramUpdates } from "../src/telegram/telegram-updates";
import { TenantConfigService } from "../src/tenant-config/tenant-config.service";
import { GOOD_TELEGRAM_TOKEN, type FakeTelegram } from "./setup/fake-telegram";
import { createTestApp, eventually, createTenant } from "./setup/test-app";

const GROUP = "-1001234567890";

describe("Telegram (integration)", () => {
  let app: NestFastifyApplication;
  let telegram: FakeTelegram;
  let admin: Awaited<ReturnType<typeof createTestApp>>["adminRequest"];
  let db: Db;
  let tenantId: string;

  beforeAll(async () => {
    ({ app, telegram, adminRequest: admin } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    telegram.sent = [];
    telegram.failures = [];
    telegram.updates = [];
    tenantId = await createTenant(app, 1000);
  });

  const connect = () =>
    admin("PUT", `/admin/tenants/${tenantId}/telegram`, { botToken: GOOD_TELEGRAM_TOKEN });

  it("connects a bot after checking the token, storing it encrypted", async () => {
    expect(
      (await admin("PUT", `/admin/tenants/${tenantId}/telegram`, { botToken: "1:bad" })).statusCode,
    ).toBe(400);
    const res = await connect();
    expect(res.json()).toEqual({ botId: "123456", botUsername: "notify_test_bot" });
    const [row] = await db.select().from(telegramConnections);
    expect(row!.botTokenEncrypted).not.toContain(GOOD_TELEGRAM_TOKEN);
  });

  it("refuses to connect a bot that another tenant already uses", async () => {
    await connect();
    const other = await createTenant(app, 1002, "other");
    const res = await admin("PUT", `/admin/tenants/${other}/telegram`, {
      botToken: GOOD_TELEGRAM_TOKEN,
    });
    expect(res.statusCode).toBe(409);
    // Reconnecting the same tenant's bot is fine.
    expect((await connect()).statusCode).toBe(200);
  });

  describe("worker reconcile", () => {
    const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
    afterEach(() => {
      app.get(TelegramPoller).onApplicationShutdown();
      telegram.revoked = false;
      telegram.getUpdatesOffsets = [];
    });

    it("starts polling a bot connected by another process", async () => {
      // This app runs as ROLE=api, like the process that served PUT /admin/…/telegram.
      await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
      expect(telegram.getUpdatesOffsets).toEqual([]);
      await app.get(TelegramPoller).reconcile();
      await eventually(async () => (telegram.getUpdatesOffsets.length > 0 ? true : undefined));
    });

    it("stops on a revoked token until the bot is connected again", async () => {
      const connections = app.get(TelegramConnectionsService);
      const poller = app.get(TelegramPoller);
      await connections.connect(tenantId, GOOD_TELEGRAM_TOKEN);
      telegram.revoked = true;
      await poller.reconcile();
      await pause();
      await poller.reconcile();
      await pause();
      expect(telegram.getUpdatesOffsets).toHaveLength(1);

      telegram.revoked = false;
      await connections.connect(tenantId, GOOD_TELEGRAM_TOKEN);
      await poller.reconcile();
      await eventually(async () => (telegram.getUpdatesOffsets.length > 1 ? true : undefined));
    });
  });

  it("does not save the old bot's offset after reconnecting to another bot", async () => {
    const connections = app.get(TelegramConnectionsService);
    const poller = app.get(TelegramPoller);
    let release!: () => void;
    const handled = new Promise<void>((resolve) => (release = resolve));
    const handle = vi
      .spyOn(app.get(TelegramUpdates), "handle")
      .mockImplementationOnce(() => handled);
    try {
      telegram.updates = [{ update_id: 5 } as never];
      poller.start(await connections.connect(tenantId, GOOD_TELEGRAM_TOKEN));
      await eventually(async () => (handle.mock.calls.length > 0 ? true : undefined));

      // The tenant switches bots while the old loop is still handling its batch.
      telegram.updates = [];
      poller.start(await connections.connect(tenantId, GOOD_TELEGRAM_TOKEN));
      release();
      await new Promise((r) => setTimeout(r, 100));

      const [row] = await db.select().from(telegramConnections);
      expect(row!.lastUpdateId).toBe(0);
    } finally {
      poller.onApplicationShutdown();
      handle.mockRestore();
    }
  });

  describe("updates", () => {
    const handle = async (update: object) => {
      await connect();
      const api = (await app.get(TelegramConnectionsService).api(tenantId))!;
      await app.get(TelegramUpdates).handle(tenantId, api, update as never, "notify_test_bot");
    };

    it("answers /chatid with the chat id and a config snippet", async () => {
      await handle({
        update_id: 1,
        message: {
          message_id: 7,
          chat: { id: -100555, type: "supergroup", title: "FE <alerts>" },
          text: "/chatid@notify_test_bot",
        },
      });
      expect(telegram.sent).toHaveLength(1);
      expect(telegram.sent[0]!.chatId).toBe("-100555");
      expect(telegram.sent[0]!.message.text).toContain("<code>-100555</code>");
      expect(telegram.sent[0]!.message.text).toContain("«FE &lt;alerts&gt;»");
      expect(telegram.sent[0]!.options).toEqual({ replyToMessageId: 7 });
    });

    it("ignores commands addressed to another bot in the group", async () => {
      await handle({
        update_id: 3,
        message: {
          message_id: 8,
          chat: { id: -100555, type: "supergroup", title: "FE" },
          text: "/chatid@SomeOtherBot",
        },
      });
      expect(telegram.sent).toEqual([]);
    });

    it("introduces itself with the chat id when added to a group", async () => {
      await handle({
        update_id: 2,
        my_chat_member: {
          chat: { id: -100777, type: "group", title: "QA" },
          old_chat_member: { status: "left" },
          new_chat_member: { status: "member" },
        },
      });
      expect(telegram.sent[0]!.message.text).toContain("<code>-100777</code>");
    });

    it("ignores ordinary messages", async () => {
      await handle({
        update_id: 3,
        message: { message_id: 1, chat: { id: -1, type: "group" }, text: "hello" },
      });
      expect(telegram.sent).toEqual([]);
    });
  });

  it("long-polls in worker processes and remembers the offset", async () => {
    const worker = await createTestApp({ role: "all" });
    try {
      const wdb = worker.app.get(DB);
      await wdb.delete(tenants);
      const [tenant] = await wdb
        .insert(tenants)
        .values({ githubInstallationId: 1001, githubOrgLogin: "acme" })
        .returning();
      worker.telegram.updates = [
        {
          update_id: 41,
          message: { message_id: 1, chat: { id: -100, type: "group" }, text: "/chatid" },
        },
      ];
      await worker.app.get(TelegramConnectionsService).connect(tenant!.id, GOOD_TELEGRAM_TOKEN);

      await eventually(async () => (worker.telegram.sent.length ? true : undefined));
      const row = await eventually(async () => {
        const [r] = await wdb.select().from(telegramConnections);
        return r?.lastUpdateId === 41 ? r : undefined;
      });
      expect(row.lastUpdateId).toBe(41);
      await eventually(async () =>
        worker.telegram.getUpdatesOffsets.includes(42) ? true : undefined,
      );
    } finally {
      await worker.app.close();
    }
  });

  describe("delivery", () => {
    const route = `
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ telegram: "${GROUP}" }]
template:
  - header: "Failed on {{ data.branch }}"
  - text: "by {{ recipients | mention }}"
  - buttons: [{ text: Run, url: "https://ci.example/1" }]`;

    const notificationFor = async (recipients: string[]) => {
      await connect();
      const parsed = parseConfigTree({ "routes/r.yaml": route });
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const version = await app
        .get(TenantConfigService)
        .recordValid(tenantId, "sha", parsed.config, []);
      const people = app.get(PeopleService);
      await people.linkAccounts(tenantId, {
        displayName: "Bob <B>",
        accounts: [
          {
            provider: "github",
            externalId: "2",
            handle: "bob",
            source: "oauth",
            confidence: "verified",
          },
          { provider: "telegram", externalId: "42", source: "deeplink", confidence: "verified" },
        ],
      });
      await people.linkAccounts(tenantId, {
        displayName: "Carol",
        accounts: [
          {
            provider: "github",
            externalId: "3",
            handle: "carol",
            source: "oauth",
            confidence: "verified",
          },
          {
            provider: "telegram",
            externalId: "43",
            handle: "carol_tg",
            source: "deeplink",
            confidence: "verified",
          },
        ],
      });
      const [n] = await db
        .insert(notifications)
        .values({
          tenantId,
          routeId: "r",
          configVersionId: version.id,
          source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
          data: { branch: "main" },
          recipients,
        })
        .returning();
      return n!.id;
    };

    it("sends HTML with Telegram mentions and buttons, storing the message ref", async () => {
      const id = await notificationFor(["github:bob", "github:carol", "github:ghost"]);

      expect(await app.get(DeliveryService).deliver(id, { attempt: 1, maxAttempts: 8 })).toBe(
        "delivered",
      );

      expect(telegram.sent[0]).toMatchObject({
        chatId: GROUP,
        message: {
          text: '<b>Failed on main</b>\n\nby <a href="tg://user?id=42">Bob &lt;B&gt;</a>, @carol_tg, ghost',
          buttons: [[{ text: "Run", url: "https://ci.example/1" }]],
        },
      });
      const [d] = await db.select().from(deliveries).where(eq(deliveries.notificationId, id));
      expect(d!.providerMessageRef).toEqual({ provider: "telegram", chatId: GROUP, messageId: 1 });
    });

    it("retries 5xx and fails on 4xx", async () => {
      const id = await notificationFor([]);
      telegram.failures = [new TelegramApiError(502, "Bad Gateway")];
      await expect(
        app.get(DeliveryService).deliver(id, { attempt: 1, maxAttempts: 8 }),
      ).rejects.toThrow(RetryLater);

      telegram.failures = [new TelegramApiError(400, "Bad Request: chat not found")];
      expect(await app.get(DeliveryService).deliver(id, { attempt: 2, maxAttempts: 8 })).toBe(
        "failed",
      );
      const [d] = await db.select().from(deliveries).where(eq(deliveries.notificationId, id));
      expect(d!.lastError).toBe("telegram: Bad Request: chat not found");
    });
  });
});
