import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { identities, tenants } from "../src/db/schema";
import { PeopleService } from "../src/identity/people.service";
import { SlackCommands } from "../src/slack/slack-commands";
import { TelegramConnectionsService } from "../src/telegram/telegram-connections.service";
import { TelegramUpdates } from "../src/telegram/telegram-updates";
import {
  GOOD_TELEGRAM_TOKEN,
  OTHER_TELEGRAM_TOKEN,
  type FakeTelegram,
} from "./setup/fake-telegram";
import { createTestApp } from "./setup/test-app";
import { cookiesOf } from "./setup/web-login";

describe("account linking (integration)", () => {
  let app: NestFastifyApplication;
  let telegram: FakeTelegram;
  let githubOAuthUsers: Map<string, { id: number; login: string }>;
  let db: Db;
  let commands: SlackCommands;
  let tenantId: string;
  let personId: string;

  beforeAll(async () => {
    ({ app, telegram, githubOAuthUsers } = await createTestApp());
    db = app.get(DB);
    commands = app.get(SlackCommands);
  });

  afterAll(async () => {
    await app?.close();
  });

  const newTenant = async (installationId: number) => {
    const [tenant] = await db
      .insert(tenants)
      .values({ githubInstallationId: installationId, githubOrgLogin: `org${installationId}` })
      .returning();
    return tenant!.id;
  };

  beforeEach(async () => {
    await db.delete(tenants);
    telegram.sent = [];
    githubOAuthUsers.clear();
    tenantId = await newTenant(1100);
    ({ personId } = await app.get(PeopleService).linkAccounts(tenantId, {
      displayName: "Alice",
      accounts: [
        { provider: "slack", externalId: "UALICE", source: "sync", confidence: "verified" },
        { provider: "email", externalId: "alice@acme.com", source: "sync", confidence: "verified" },
      ],
    }));
    await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
  });

  const notify = (text: string, userId = "UALICE") => commands.handle(tenantId, { userId, text });
  const identity = async (provider: "github" | "telegram") =>
    (
      await db
        .select()
        .from(identities)
        .where(and(eq(identities.tenantId, tenantId), eq(identities.provider, provider)))
    )[0];

  describe("/notify", () => {
    it("shows help and refuses unknown users", async () => {
      expect(await notify("")).toContain("/notify link github");
      expect(await notify("whoami", "USTRANGER")).toContain("I don't know you yet");
      expect(await notify("dance")).toContain("Unknown command");
    });

    it("whoami lists linked accounts", async () => {
      const text = await notify("whoami");
      expect(text).toContain("*Alice*");
      expect(text).toContain("• *email*: alice@acme.com — verified via sync");
      expect(text).toContain("• *slack*: <@UALICE> — verified via sync");
    });
  });

  describe("Telegram deep-link", () => {
    const tokenFrom = (reply: string) => /\?start=([\w-]+)\|/.exec(reply)![1]!;
    const start = async (
      token: string,
      from = { id: 77, username: "Alice_TG" },
      tenant = tenantId,
    ) => {
      const api = (await app.get(TelegramConnectionsService).api(tenant))!;
      await app.get(TelegramUpdates).handle(
        tenant,
        api,
        {
          update_id: 1,
          message: {
            message_id: 1,
            chat: { id: from.id, type: "private" },
            from,
            text: `/start ${token}`,
          },
        },
        "notify_test_bot",
      );
      return telegram.sent.at(-1)!.message.text;
    };

    it("links the Telegram account that opened the link as verified", async () => {
      const reply = await notify("link telegram");
      expect(reply).toContain("https://t.me/notify_test_bot?start=");

      expect(await start(tokenFrom(reply))).toContain(
        "Linked this Telegram account to <b>Alice</b>",
      );
      expect(await identity("telegram")).toMatchObject({
        personId,
        externalId: "77",
        handle: "alice_tg",
        source: "deeplink",
        confidence: "verified",
      });
    });

    it("accepts a token only once", async () => {
      const token = tokenFrom(await notify("link telegram"));
      await start(token);
      expect(await start(token, { id: 99, username: "mallory" })).toContain("invalid or expired");
    });

    it("rejects expired tokens", async () => {
      const token = tokenFrom(await notify("link telegram"));
      await db.execute(sql`update link_tokens set expires_at = now() - interval '1 second'`);
      expect(await start(token)).toContain("invalid or expired");
      expect(await identity("telegram")).toBeUndefined();
    });

    it("never takes a Telegram account away from another person", async () => {
      const { personId: bob } = await app.get(PeopleService).linkAccounts(tenantId, {
        displayName: "Bob",
        accounts: [{ provider: "telegram", externalId: "77", source: "sync", confidence: "high" }],
      });
      expect(await start(tokenFrom(await notify("link telegram")))).toContain("someone else");
      expect(await identity("telegram")).toMatchObject({ personId: bob });
    });

    it("rejects a token presented to another tenant's bot", async () => {
      const token = tokenFrom(await notify("link telegram"));
      const other = await newTenant(1101);
      await app.get(TelegramConnectionsService).connect(other, OTHER_TELEGRAM_TOKEN);
      expect(await start(token, undefined, other)).toContain("invalid or expired");
    });
  });

  describe("GitHub OAuth", () => {
    const callback = (query: string) =>
      app.inject({ method: "GET", url: `/oauth/github/callback?${query}` });
    const stateFrom = async () =>
      new URL(/<(https:[^|]+)\|/.exec(await notify("link github"))![1]!).searchParams.get("state")!;
    /** OAuth as `user`; returns the confirmation page and its browser's cookie. */
    const approve = async (state: string, user: { id: number; login: string }) => {
      githubOAuthUsers.set("code", user);
      const page = await callback(`code=code&state=${state}`);
      const cookie = cookiesOf(page.headers["set-cookie"]).join("; ");
      return { page, cookie };
    };
    const confirm = (state: string, cookie?: string) =>
      app.inject({
        method: "POST",
        url: `/oauth/github/confirm?state=${encodeURIComponent(state)}`,
        headers: cookie ? { cookie } : {},
      });

    it("asks whom to link to, then links the account that approved", async () => {
      const reply = await notify("link github");
      const url = new URL(/<(https:\/\/github\.com[^|]+)\|/.exec(reply)![1]!);
      expect(url.searchParams.get("client_id")).toBe("Iv-test-client");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://notify.test/oauth/github/callback",
      );
      const state = url.searchParams.get("state")!;

      const { page, cookie } = await approve(state, { id: 501, login: "Alice-Personal" });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(page.body).toContain("Link GitHub @Alice-Personal to Alice?");
      expect(page.body).toContain('<form method="post" action="/oauth/github/confirm?state=');
      expect(await identity("github")).toBeUndefined();

      const done = await confirm(state, cookie);
      expect(done.body).toContain("Linked GitHub to Alice");
      expect(await identity("github")).toMatchObject({
        personId,
        externalId: "501",
        handle: "alice-personal",
        source: "oauth",
        confidence: "verified",
      });
      // The token is spent.
      expect((await confirm(state, cookie)).body).toContain("invalid or expired");
    });

    it("cannot be confirmed by anyone but the browser that approved it", async () => {
      // Alice forwards her link; Victor approves it with his GitHub account.
      const state = await stateFrom();
      await approve(state, { id: 777, login: "victor" });
      // Alice knows the state but not Victor's browser nonce.
      const { cookie: aliceCookie } = await approve(await stateFrom(), { id: 501, login: "a" });
      expect((await confirm(state)).body).toContain("invalid or expired");
      expect((await confirm(state, aliceCookie)).body).toContain("invalid or expired");
      expect(await identity("github")).toBeUndefined();
    });

    it("never takes a GitHub account away from another person", async () => {
      const { personId: bob } = await app.get(PeopleService).linkAccounts(tenantId, {
        displayName: "Bob",
        accounts: [
          {
            provider: "github",
            externalId: "501",
            handle: "x",
            source: "admin",
            confidence: "high",
          },
        ],
      });
      const state = await stateFrom();
      const { cookie } = await approve(state, { id: 501, login: "x" });

      expect((await confirm(state, cookie)).body).toContain("already linked to someone else");
      expect(await identity("github")).toMatchObject({ personId: bob, confidence: "high" });
    });

    it("explains broken callbacks", async () => {
      expect((await callback("code=x")).body).toContain("link is incomplete");
      expect((await callback("code=unknown&state=abc")).body).toContain("GitHub did not confirm");
      githubOAuthUsers.set("code-3", { id: 1, login: "y" });
      expect((await callback("code=code-3&state=forged")).body).toContain("invalid or expired");
    });
  });
});
