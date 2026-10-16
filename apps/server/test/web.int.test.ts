import { existsSync } from "node:fs";
import path from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, type Db } from "../src/db/db";
import { persons, tenants } from "../src/db/schema";
import { PeopleService } from "../src/identity/people.service";
import { TelegramConnectionsService } from "../src/telegram/telegram-connections.service";
import type { FakeGithub } from "./setup/fake-github";
import { GOOD_TELEGRAM_TOKEN, type FakeTelegram } from "./setup/fake-telegram";
import { cookiesOf } from "./setup/web-login";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const CONFIG = {
  "teams.yaml": "teams:\n  fe: { slack_channel: '#fe' }",
  "routes/e2e.yaml": `
id: e2e
description: e2e failures
allowed_sources: { github_repos: [acme/e2e], api_keys: [ci] }
destinations: [{ slack: "#alerts" }, { team: fe }]
dm: true
schema: { type: object, properties: { branch: { type: string } } }
template: [{ text: hi }]`,
  "routes/deploys.yaml": `
id: deploys
allowed_sources: { api_keys: [cd] }
destinations: [{ telegram: "-100" }]
template: [{ text: hi }]`,
};

describe("web UI backend (integration)", () => {
  let app: NestFastifyApplication;
  let github: FakeGithub;
  let githubOAuthUsers: Map<string, { id: number; login: string }>;
  let telegram: FakeTelegram;
  let db: Db;
  let tenantId: string;
  let alice: string;

  beforeAll(async () => {
    ({ app, github, githubOAuthUsers, telegram } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    githubOAuthUsers.clear();
    github.members = [
      { login: "alice-gh", id: 11 },
      { login: "bob-gh", id: 12 },
    ];
    github.orgAdmins.clear();
    github.orgAdmins.add("alice-gh");
    tenantId = await createTenant(app, 1500);
    const people = app.get(PeopleService);
    ({ personId: alice } = await people.linkAccounts(tenantId, {
      displayName: "Alice",
      accounts: [
        { provider: "slack", externalId: "UA", source: "sync", confidence: "verified" },
        {
          provider: "github",
          externalId: "11",
          handle: "alice-gh",
          source: "oauth",
          confidence: "verified",
        },
      ],
    }));
    await people.linkAccounts(tenantId, {
      displayName: "Bob",
      accounts: [
        { provider: "slack", externalId: "UB", source: "sync", confidence: "verified" },
        {
          provider: "github",
          externalId: "12",
          handle: "bob-gh",
          source: "admin",
          confidence: "high",
        },
      ],
    });
    await activateConfig(app, tenantId, CONFIG, "abc1234def");
  });

  /** Runs the whole login flow for a GitHub user; returns the session cookie header. */
  const login = async (user: { id: number; login: string }) => {
    const start = await app.inject({ method: "GET", url: "/auth/github/login" });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    githubOAuthUsers.set("code", user);
    const callback = await app.inject({
      method: "GET",
      url: `/oauth/github/callback?code=code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookiesOf(start.headers["set-cookie"]).join("; ") },
    });
    return {
      callback,
      cookie: cookiesOf(callback.headers["set-cookie"]).find((c) =>
        c.startsWith("callog_session="),
      )!,
    };
  };

  const get = (url: string, cookie?: string) =>
    app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

  describe("login", () => {
    it("starts GitHub OAuth with a login state bound to a cookie", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/github/login" });
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(location.searchParams.get("state")).toMatch(/^login\./);
      const setCookie = String(res.headers["set-cookie"]);
      expect(setCookie).toContain("callog_login_state=login.");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
    });

    it("signs in a linked GitHub user and redirects to the app", async () => {
      const { callback, cookie } = await login({ id: 11, login: "Alice-GH" });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("/");
      expect(cookie).toMatch(/^callog_session=/);
      expect((await get("/api/me", cookie)).json().person.name).toBe("Alice");
    });

    it("rejects a login state that does not match the browser cookie", async () => {
      const start = await app.inject({ method: "GET", url: "/auth/github/login" });
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      githubOAuthUsers.set("code", { id: 11, login: "alice-gh" });
      const res = await app.inject({
        method: "GET",
        url: `/oauth/github/callback?code=code&state=${state}`,
      });
      expect(res.body).toContain("sign-in attempt expired");
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("explains how to link an unknown GitHub account", async () => {
      const { callback } = await login({ id: 999, login: "stranger" });
      expect(callback.body).toContain("not linked to anyone here yet");
    });

    it("ends sessions and refuses logins of a tenant whose app was uninstalled", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      await db.update(tenants).set({ status: "inactive" }).where(eq(tenants.id, tenantId));
      expect((await get("/api/me", cookie)).statusCode).toBe(401);
      const { callback } = await login({ id: 11, login: "alice-gh" });
      expect(callback.body).toContain("not linked to anyone here yet");
    });

    it("ends the session on logout and for deactivated people", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      await db.update(persons).set({ status: "inactive" }).where(eq(persons.id, alice));
      expect((await get("/api/me", cookie)).statusCode).toBe(401);
      await db.update(persons).set({ status: "active" }).where(eq(persons.id, alice));
      expect((await get("/api/me", cookie)).statusCode).toBe(200);

      const out = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie },
      });
      expect(out.statusCode).toBe(204);
      expect((await get("/api/me", cookie)).statusCode).toBe(401);
    });
  });

  it.skipIf(!existsSync(path.resolve(__dirname, "../../web/dist/index.html")))(
    "serves the web UI for client routes, never inside a frame",
    async () => {
      const res = await get("/routes");
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    },
  );

  describe("API", () => {
    it("401 without a session", async () => {
      expect((await get("/api/me")).statusCode).toBe(401);
      expect((await get("/api/routes")).statusCode).toBe(401);
      expect((await get("/api/me", "callog_session=%E0%A4%A")).statusCode).toBe(401);
    });

    it("/api/me: identities, preferences and admin for an org owner", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      const me = (await get("/api/me", cookie)).json();
      expect(me).toMatchObject({
        person: { name: "Alice" },
        org: "acme",
        isAdmin: true,
        preferences: { dmChannel: "slack", mutedRoutes: [] },
      });
      expect(me.identities.map((i: { provider: string }) => i.provider)).toEqual([
        "github",
        "slack",
      ]);
    });

    it("admin also for GitHub org owners, not for ordinary members (cached a minute)", async () => {
      const { cookie } = await login({ id: 12, login: "bob-gh" });
      const isAdmin = async () => (await get("/api/me", cookie)).json().isAdmin;
      const roleChecks = () =>
        github.requests.filter((r) => r.startsWith("GET /orgs/{org}/memberships")).length;
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const before = roleChecks();
        expect(await isAdmin()).toBe(false);
        github.orgAdmins.add("bob-gh");
        expect(await isAdmin()).toBe(false);
        expect(roleChecks()).toBe(before + 1);

        clock.mockReturnValue(now + 61_000);
        expect(await isAdmin()).toBe(true);
        // GitHub down: the last known answer stands.
        github.down = true;
        clock.mockReturnValue(now + 122_000);
        expect(await isAdmin()).toBe(true);
      } finally {
        github.down = false;
        clock.mockRestore();
      }
    });

    it("/api/routes summarises the active config", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      const body = (await get("/api/routes", cookie)).json();
      expect(body).toMatchObject({ configRepo: "acme/notify-config", commitSha: "abc1234def" });
      expect(body.routes.find((r: { id: string }) => r.id === "e2e")).toEqual({
        id: "e2e",
        description: "e2e failures",
        destinations: [
          { provider: "slack", destination: "#alerts" },
          { provider: "slack", destination: "#fe" },
        ],
        dm: true,
        mentions: "recipients",
        allowedSources: { github_repos: ["acme/e2e"], api_keys: ["ci"] },
        dataFields: ["branch"],
        muted: false,
        url: "https://github.com/acme/notify-config/blob/abc1234def/routes/e2e.yaml",
      });
    });

    it("/api/routes labels Telegram chats with their cached titles", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      const deploys = async () =>
        (await get("/api/routes", cookie))
          .json()
          .routes.find((r: { id: string }) => r.id === "deploys").destinations;
      // No bot connected: the raw id only.
      expect(await deploys()).toEqual([{ provider: "telegram", destination: "-100" }]);

      await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
      telegram.chats.set("-100", { id: -100, type: "supergroup", title: "Deploys" });
      telegram.getChatCalls = [];
      const labelled = [{ provider: "telegram", destination: "-100", label: "Deploys" }];
      expect(await deploys()).toEqual(labelled);
      expect(await deploys()).toEqual(labelled);
      expect(telegram.getChatCalls).toEqual(["-100"]);
    });

    it("/api/routes still answers when Telegram is unreachable", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
      telegram.getChatUnreachable = true;
      try {
        const res = await get("/api/routes", cookie);
        expect(res.statusCode).toBe(200);
        expect(
          res.json().routes.find((r: { id: string }) => r.id === "deploys").destinations,
        ).toEqual([{ provider: "telegram", destination: "-100" }]);
      } finally {
        telegram.getChatUnreachable = false;
      }
    });

    it("mutes and unmutes routes, rejecting unknown ones", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      const mute = await app.inject({
        method: "PUT",
        url: "/api/me/mutes/e2e",
        headers: { cookie },
      });
      expect(mute.json().mutedRoutes).toEqual(["e2e"]);
      expect(
        (await get("/api/routes", cookie)).json().routes.find((r: { id: string }) => r.id === "e2e")
          .muted,
      ).toBe(true);
      expect(
        (await app.inject({ method: "PUT", url: "/api/me/mutes/nope", headers: { cookie } }))
          .statusCode,
      ).toBe(404);
      const unmute = await app.inject({
        method: "DELETE",
        url: "/api/me/mutes/e2e",
        headers: { cookie },
      });
      expect(unmute.json().mutedRoutes).toEqual([]);
    });

    it("sets the DM channel; Telegram only when linked", async () => {
      const { cookie } = await login({ id: 11, login: "alice-gh" });
      const put = (channel: string) =>
        app.inject({
          method: "PUT",
          url: "/api/me/preferences/dm",
          headers: { cookie, "content-type": "application/json" },
          payload: JSON.stringify({ channel }),
        });
      expect((await put("telegram")).statusCode).toBe(400);
      await app.get(PeopleService).attachAccount(tenantId, alice, {
        provider: "telegram",
        externalId: "42",
        source: "deeplink",
        confidence: "verified",
      });
      expect((await put("telegram")).json().dmChannel).toBe("telegram");
      expect((await put("email")).statusCode).toBe(400);
    });
  });
});
