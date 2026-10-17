import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { tenants } from "../src/db/schema";
import type { TelegramChat } from "../src/telegram/telegram-api";
import { TelegramUpdates } from "../src/telegram/telegram-updates";
import type { FakeGithub } from "./setup/fake-github";
import { BAD_SLACK_APP_TOKEN, GOOD_SLACK_TOKEN } from "./setup/fake-slack";
import {
  GOOD_TELEGRAM_TOKEN,
  OTHER_TELEGRAM_TOKEN,
  type FakeTelegram,
} from "./setup/fake-telegram";
import { createTenant, createTestApp } from "./setup/test-app";
import { webLogin } from "./setup/web-login";

const group = (id: number, title: string): TelegramChat => ({ id, title, type: "supergroup" });

describe("connecting Slack and Telegram from the web UI (integration)", () => {
  let app: NestFastifyApplication;
  let github: FakeGithub;
  let telegram: FakeTelegram;
  let githubOAuthUsers: Map<string, { id: number; login: string }>;
  let db: Db;
  let tenantId: string;
  let cookie: string;
  let seq = 0;

  const call = (method: "GET" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  /** Feeds a Bot API update to the tenant's bot as the poller would. */
  const update = (u: object) =>
    app
      .get(TelegramUpdates)
      .handle(tenantId, telegram.factory(GOOD_TELEGRAM_TOKEN), { update_id: 1, ...u }, "test_bot");
  const membership = (chat: TelegramChat, from: string, to: string) =>
    update({
      my_chat_member: { chat, old_chat_member: { status: from }, new_chat_member: { status: to } },
    });

  beforeAll(async () => {
    ({ app, github, telegram, githubOAuthUsers } = await createTestApp());
    db = app.get(DB);
  });
  afterAll(() => app?.close());

  beforeEach(async () => {
    await db.delete(tenants);
    seq += 1;
    const owner = { id: 7000 + seq, login: `chan-owner-${seq}` };
    github.members = [owner];
    github.orgAdmins.clear();
    github.orgAdmins.add(owner.login);
    tenantId = await createTenant(app, 4000 + seq);
    cookie = await webLogin(app, githubOAuthUsers, owner);
  });

  describe("Slack", () => {
    it("connects with both tokens and ticks the checklist", async () => {
      const res = await call("PUT", "/api/admin/slack", {
        botToken: GOOD_SLACK_TOKEN,
        appToken: "xapp-test-good",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ team: "test-team" });
      const { steps } = (await call("GET", "/api/admin/onboarding")).json();
      expect(steps.slack).toEqual({ done: true, team: "test-team" });
    });

    it("says which token Slack refused", async () => {
      const badBot = await call("PUT", "/api/admin/slack", {
        botToken: "xoxb-wrong",
        appToken: "xapp-test-good",
      });
      expect(badBot.statusCode).toBe(400);
      expect(badBot.json().message).toBe("Slack rejected the bot token: invalid_auth");

      const badApp = await call("PUT", "/api/admin/slack", {
        botToken: GOOD_SLACK_TOKEN,
        appToken: BAD_SLACK_APP_TOKEN,
      });
      expect(badApp.statusCode).toBe(400);
      expect(badApp.json().message).toBe("Slack rejected the app-level token: invalid_auth");
      expect((await call("GET", "/api/admin/onboarding")).json().steps.slack.done).toBe(false);
    });

    it("requires the app-level token for /notify", async () => {
      const res = await call("PUT", "/api/admin/slack", { botToken: GOOD_SLACK_TOKEN });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("Telegram", () => {
    it("connects the bot and lists the groups it is in", async () => {
      const res = await call("PUT", "/api/admin/telegram", { botToken: GOOD_TELEGRAM_TOKEN });
      expect(res.statusCode).toBe(200);
      expect((await call("GET", "/api/admin/onboarding")).json().steps.telegram.done).toBe(true);

      await membership(group(-1001, "Alerts"), "left", "member");
      // A group the bot was in before chats were remembered shows up after /chatid.
      await update({
        message: { message_id: 5, chat: group(-1002, "Deploys"), text: "/chatid" },
      });
      // A private chat is not a destination.
      await update({
        message: { message_id: 6, chat: { id: 42, type: "private" }, text: "/chatid" },
      });
      expect((await call("GET", "/api/admin/telegram/chats")).json()).toEqual([
        { chatId: "-1001", title: "Alerts", type: "supergroup" },
        { chatId: "-1002", title: "Deploys", type: "supergroup" },
      ]);

      await membership(group(-1001, "Alerts"), "member", "kicked");
      expect((await call("GET", "/api/admin/telegram/chats")).json()).toEqual([
        { chatId: "-1002", title: "Deploys", type: "supergroup" },
      ]);
    });

    it("forgets the old bot's groups when another bot is connected", async () => {
      await call("PUT", "/api/admin/telegram", { botToken: GOOD_TELEGRAM_TOKEN });
      await membership(group(-1001, "Alerts"), "left", "member");
      await call("PUT", "/api/admin/telegram", { botToken: GOOD_TELEGRAM_TOKEN });
      expect((await call("GET", "/api/admin/telegram/chats")).json()).toHaveLength(1);

      await call("PUT", "/api/admin/telegram", { botToken: OTHER_TELEGRAM_TOKEN });
      expect((await call("GET", "/api/admin/telegram/chats")).json()).toEqual([]);
    });

    it("explains a rejected token", async () => {
      const res = await call("PUT", "/api/admin/telegram", { botToken: "1:wrong" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/^Telegram rejected the token/);
    });
  });
});
