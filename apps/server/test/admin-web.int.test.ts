import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import {
  configVersions,
  deliveries,
  identities,
  notifications,
  persons,
  tenants,
  unmappedRecipients,
} from "../src/db/schema";
import { PeopleService } from "../src/identity/people.service";
import type { FakeGithub } from "./setup/fake-github";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";
import { webLogin } from "./setup/web-login";

describe("admin web API (integration)", () => {
  let app: NestFastifyApplication;
  let github: FakeGithub;
  let githubOAuthUsers: Map<string, { id: number; login: string }>;
  let db: Db;
  let tenantId: string;
  let adminCookie: string;
  let bob: string;
  let versionId: string;

  beforeAll(async () => {
    ({ app, github, githubOAuthUsers } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    github.members = [{ login: "alice-gh", id: 11 }];
    github.orgAdmins.clear();
    github.orgAdmins.add("alice-gh");
    github.users = [{ login: "octocat", id: 99 }];
    github.repos.clear();
    tenantId = await createTenant(app, 1600);
    const people = app.get(PeopleService);
    await people.linkAccounts(tenantId, {
      displayName: "Alice",
      accounts: [
        {
          provider: "github",
          externalId: "11",
          handle: "alice-gh",
          source: "oauth",
          confidence: "verified",
        },
      ],
    });
    ({ personId: bob } = await people.linkAccounts(tenantId, {
      displayName: "Bob",
      accounts: [
        {
          provider: "github",
          externalId: "12",
          handle: "bob-gh",
          source: "oauth",
          confidence: "verified",
        },
        { provider: "email", externalId: "bob@acme.com", source: "sync", confidence: "verified" },
        { provider: "slack", externalId: "UB", source: "sync", confidence: "verified" },
      ],
    }));
    versionId = (
      await activateConfig(
        app,
        tenantId,
        {
          "routes/r.yaml":
            "id: r\nallowed_sources: { api_keys: [ci] }\ndestinations: [{ slack: '#a' }]\ntemplate: [{ text: hi }]",
        },
        "abc",
      )
    ).id;
    adminCookie = await webLogin(app, githubOAuthUsers, { id: 11, login: "alice-gh" });
  });

  const call = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
    cookie = adminCookie,
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });

  it("is only for admins", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/status" })).statusCode).toBe(401);
    const bobCookie = await webLogin(app, githubOAuthUsers, { id: 12, login: "bob-gh" });
    expect((await call("GET", "/api/admin/status", undefined, bobCookie)).statusCode).toBe(403);
    expect((await call("GET", "/api/admin/status")).statusCode).toBe(200);
  });

  it("lists teams with members_from resolved to people", async () => {
    github.teams.set("fe-gh", ["Alice-GH", "carol-gh"]);
    await activateConfig(
      app,
      tenantId,
      {
        "teams.yaml": `
teams:
  fe: { slack_channel: "#fe", members_from: { github_team: fe-gh } }
  ops: { telegram_chat: "-100" }`,
        "routes/r.yaml":
          "id: r\nallowed_sources: { api_keys: [ci] }\ndestinations: [{ slack: '#a' }]\ntemplate: [{ text: hi }]",
      },
      "teams",
    );
    const teams = (await call("GET", "/api/admin/teams")).json();
    expect(teams).toEqual([
      {
        slug: "fe",
        slackChannel: "#fe",
        telegramChat: null,
        membersFrom: { githubTeam: "fe-gh", slackUsergroup: null },
        reason: null,
        total: 2,
        linked: 1,
        members: [
          {
            ref: "github:Alice-GH",
            provider: "github",
            handle: "Alice-GH",
            person: { id: expect.any(String), name: "Alice", status: "active" },
          },
          { ref: "github:carol-gh", provider: "github", handle: "carol-gh", person: null },
        ],
      },
      {
        slug: "ops",
        slackChannel: null,
        telegramChat: "-100",
        membersFrom: null,
        reason: 'team "ops" has no members_from, it is only an address',
        total: 0,
        linked: 0,
        members: [],
      },
    ]);
  });

  it("grants and revokes the admin role; it ends when the person leaves", async () => {
    const bobCookie = await webLogin(app, githubOAuthUsers, { id: 12, login: "bob-gh" });
    const asBob = () => call("GET", "/api/admin/admins", undefined, bobCookie);
    const admins = async () => (await call("GET", "/api/admin/admins")).json();
    expect((await asBob()).statusCode).toBe(403);

    const before = await admins();
    expect(before.owners).toEqual([
      { login: "alice-gh", person: { id: expect.any(String), name: "Alice" } },
    ]);
    expect(before.admins).toEqual([]);

    expect((await call("POST", "/api/admin/admins", { personId: bob })).json()).toEqual({
      ok: true,
      changed: true,
    });
    expect((await asBob()).statusCode).toBe(200);
    const after = await admins();
    expect(after.admins).toEqual([
      {
        person: { id: bob, name: "Bob", status: "active" },
        grantedBy: "Alice",
        grantedAt: expect.any(String),
      },
    ]);
    // Granting again is a no-op and leaves no audit entry.
    expect((await call("POST", "/api/admin/admins", { personId: bob })).json().changed).toBe(false);

    // Owners are GitHub's business.
    const alice = before.owners[0].person.id;
    expect((await call("DELETE", `/api/admin/admins/${alice}`)).statusCode).toBe(400);

    // Leaving Slack drops the role, with a system audit entry.
    const people = app.get(PeopleService);
    await people.setActiveByIdentity(tenantId, "slack", "UB", false);
    expect((await admins()).admins).toEqual([]);
    expect((await asBob()).statusCode).not.toBe(200);
    expect((await call("POST", "/api/admin/admins", { personId: bob })).statusCode).toBe(400);

    // Back, granted again, revoked by hand.
    await people.setActiveByIdentity(tenantId, "slack", "UB", true);
    await call("POST", "/api/admin/admins", { personId: bob });
    expect((await call("DELETE", `/api/admin/admins/${bob}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/api/admin/admins/${bob}`)).statusCode).toBe(404);
    const { audit } = await admins();
    expect(
      audit.map((e: { action: string; actor: string | null; details: unknown }) => [
        e.action,
        e.actor,
        e.details,
      ]),
    ).toEqual([
      ["admin.revoked", "Alice", null],
      ["admin.granted", "Alice", null],
      ["admin.revoked", null, { reason: "inactive" }],
      ["admin.granted", "Alice", null],
    ]);
  });

  it("status shows config, channels and the last 24 hours", async () => {
    await db.insert(notifications).values([
      {
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        status: "delivered",
      },
      {
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        status: "failed",
      },
    ]);
    expect((await call("GET", "/api/admin/status")).json()).toMatchObject({
      org: "acme",
      configRepo: "acme/notify-config",
      config: { active: { commitSha: "abc", routes: 1 }, latest: { status: "valid" } },
      slack: null,
      telegram: null,
    });
  });

  it("lists notifications and shows payload and delivery errors", async () => {
    const [n] = await db
      .insert(notifications)
      .values({
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "github_oidc", repository: "acme/e2e" },
        data: { branch: "main" },
        recipients: ["github:octocat"],
        status: "partially_failed",
      })
      .returning();
    await db.insert(deliveries).values({
      tenantId,
      notificationId: n!.id,
      provider: "slack",
      destination: "#a",
      status: "failed",
      attempts: 1,
      lastError: "slack: channel_not_found",
    });

    const list = (await call("GET", "/api/admin/notifications?status=partially_failed")).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      route: "r",
      deliveries: [{ destination: "#a", status: "failed" }],
    });
    expect((await call("GET", "/api/admin/notifications?status=delivered")).json().items).toEqual(
      [],
    );

    for (const query of ["status=bogus", "before=yesterday", "period=1y"]) {
      expect((await call("GET", `/api/admin/notifications?${query}`)).statusCode).toBe(400);
    }

    expect(
      (await call("GET", "/api/admin/notifications?source=acme%2Fe2e")).json().items,
    ).toHaveLength(1);
    expect((await call("GET", "/api/admin/notifications?source=other")).json().items).toEqual([]);
    await db
      .update(notifications)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(notifications.id, n!.id));
    expect((await call("GET", "/api/admin/notifications?period=24h")).json().items).toEqual([]);
    expect((await call("GET", "/api/admin/notifications?period=7d")).json().items).toHaveLength(1);

    const details = (await call("GET", `/api/admin/notifications/${n!.id}`)).json();
    expect(details).toMatchObject({
      data: { branch: "main" },
      recipients: ["github:octocat"],
      deliveries: [{ lastError: "slack: channel_not_found", attempts: 1 }],
    });
  });

  it("lists config versions and explains a rejected one", async () => {
    await new Promise((r) => setTimeout(r, 5));
    const [rejected] = await db
      .insert(configVersions)
      .values({
        tenantId,
        commitSha: "def",
        status: "invalid",
        errors: { errors: [{ file: "routes/r.yaml", path: ["template"], message: "Required" }] },
      })
      .returning();

    const list = (await call("GET", "/api/admin/config/versions")).json();
    expect(list.items).toMatchObject([
      { commitSha: "def", status: "invalid", errors: 1, routes: 0, active: false },
      { commitSha: "abc", status: "valid", errors: 0, routes: 1, active: true },
    ]);
    expect(list.nextBefore).toBeNull();

    const details = (await call("GET", `/api/admin/config/versions/${rejected!.id}`)).json();
    expect(details).toMatchObject({
      commitSha: "def",
      active: false,
      errors: [{ file: "routes/r.yaml", path: ["template"], message: "Required" }],
      previousCommitSha: "abc",
    });
  });

  it("searches people by name or account, a page at a time", async () => {
    await db.insert(persons).values(
      Array.from({ length: 1200 }, (_, i) => ({
        tenantId,
        displayName: `Person ${String(i).padStart(4, "0")}`,
      })),
    );

    const first = (await call("GET", "/api/admin/people")).json();
    expect(first.total).toBe(1202);
    expect(first.items).toHaveLength(first.pageSize);
    const last = (await call("GET", "/api/admin/people?page=25")).json();
    expect(last.items.map((p: { name: string }) => p.name)).toEqual(["Person 1198", "Person 1199"]);

    const byName = (await call("GET", "/api/admin/people?q=person%20011")).json();
    expect(byName.total).toBe(10);
    const byLogin = (await call("GET", "/api/admin/people?q=BOB-GH")).json();
    expect(byLogin.items.map((p: { name: string }) => p.name)).toEqual(["Bob"]);
    const byEmail = (await call("GET", "/api/admin/people?q=bob%40acme")).json();
    expect(byEmail.total).toBe(1);
    // LIKE wildcards in the query are matched literally.
    expect((await call("GET", "/api/admin/people?q=%25")).json().total).toBe(0);

    expect((await call("GET", "/api/admin/people/options")).json()).toHaveLength(1202);
    expect((await call("GET", "/api/admin/people?page=0")).statusCode).toBe(400);
  });

  it("shows a person with their role, preferences and notifications naming them", async () => {
    await db.insert(notifications).values([
      {
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        recipients: ["github:Bob-GH"],
      },
      {
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        recipients: ["github:someone-else"],
      },
    ]);

    const card = (await call("GET", `/api/admin/people/${bob}`)).json();
    expect(card).toMatchObject({
      name: "Bob",
      status: "active",
      admin: false,
      preferences: { dmChannel: "slack", mutedRoutes: [] },
      recentNotifications: [{ route: "r", status: "accepted" }],
    });
    expect(card.identities.map((i: { provider: string }) => i.provider).sort()).toEqual([
      "email",
      "github",
      "slack",
    ]);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call("GET", `/api/admin/people/${missing}`)).statusCode).toBe(404);
  });

  it("runs maintenance for this workspace only and remembers the last run", async () => {
    expect((await call("GET", "/api/admin/maintenance")).json()).toEqual({
      sync: null,
      retention: null,
    });
    const bobCookie = await webLogin(app, githubOAuthUsers, { id: 12, login: "bob-gh" });
    expect(
      (await call("POST", "/api/admin/maintenance/sync", undefined, bobCookie)).statusCode,
    ).toBe(403);

    const sync = await call("POST", "/api/admin/maintenance/sync");
    expect(sync.statusCode).toBe(202);
    expect(sync.json()).toEqual({ status: "queued" });

    const old = new Date(Date.now() - 400 * 86_400_000);
    await db.insert(notifications).values({
      tenantId,
      routeId: "r",
      configVersionId: versionId,
      source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
      status: "delivered",
      createdAt: old,
    });
    const retention = await call("POST", "/api/admin/maintenance/retention");
    expect(retention.json()).toEqual({
      notifications: 1,
      configVersions: 0,
      unmappedRecipients: 0,
    });

    const last = (await call("GET", "/api/admin/maintenance")).json();
    expect(last.sync).toMatchObject({ at: expect.any(String) });
    expect(last.retention).toMatchObject({ details: { notifications: 1 } });
    // The role log on the Admins page lists role changes only.
    expect((await call("GET", "/api/admin/admins")).json().audit).toEqual([]);
  });

  it("lists what needs attention and drops what is fixed", async () => {
    await db.insert(notifications).values({
      tenantId,
      routeId: "r",
      configVersionId: versionId,
      source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
      status: "failed",
    });
    await db
      .insert(unmappedRecipients)
      .values({ tenantId, ref: "github:ghost", provider: "slack" });

    const before = (await call("GET", "/api/admin/attention")).json();
    expect(before.items).toEqual([
      { kind: "slack_missing" },
      { kind: "failed", count: 1 },
      { kind: "unmapped", count: 1 },
    ]);
    expect(before.counters).toEqual({
      routes: 1,
      people: 2,
      notifications24h: 1,
      delivered24h: 0,
    });

    await db.delete(unmappedRecipients);
    const [rejected] = await db
      .insert(configVersions)
      .values({ tenantId, commitSha: "bad", status: "invalid", errors: { errors: [{}] } })
      .returning();
    const after = (await call("GET", "/api/admin/attention")).json();
    expect(after.items).toEqual([
      { kind: "config_rejected", versionId: rejected!.id, errors: 1 },
      { kind: "slack_missing" },
      { kind: "failed", count: 1 },
    ]);
  });

  it("retries a failed notification once", async () => {
    const [n] = await db
      .insert(notifications)
      .values({
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        status: "failed",
      })
      .returning();

    const res = await call("POST", `/api/admin/notifications/${n!.id}/retry`);
    expect(res.statusCode).toBe(202);
    expect((await call("POST", `/api/admin/notifications/${n!.id}/retry`)).statusCode).toBe(409);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call("POST", `/api/admin/notifications/${missing}/retry`)).statusCode).toBe(404);
  });

  it("links an unmapped recipient to a person and clears it from the report", async () => {
    await db
      .insert(unmappedRecipients)
      .values({ tenantId, ref: "github:octocat", provider: "slack" });

    const res = await call("POST", "/api/admin/links", { personId: bob, ref: "github:octocat" });

    expect(res.json()).toEqual({ ok: true, outcome: "added" });
    const [row] = await db
      .select()
      .from(identities)
      .where(and(eq(identities.personId, bob), eq(identities.externalId, "99")));
    expect(row).toMatchObject({
      provider: "github",
      handle: "octocat",
      source: "admin",
      confidence: "verified",
    });
    expect((await call("GET", "/api/admin/unmapped")).json()).toEqual([]);
  });

  it("refuses to steal a verified account and reports unknown GitHub users", async () => {
    expect(
      (await call("POST", "/api/admin/links", { personId: bob, ref: "github:alice-gh" }))
        .statusCode,
    ).toBe(400);
    const res = await call("POST", "/api/admin/links", { personId: bob, ref: "github:ghost" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('"ghost" not found');
  });

  it("confirms and rejects suggested links", async () => {
    const people = app.get(PeopleService);
    await people.attachAccount(tenantId, bob, {
      provider: "github",
      externalId: "50",
      handle: "maybe",
      source: "commit_heuristic",
      confidence: "suggested",
    });
    await people.attachAccount(tenantId, bob, {
      provider: "github",
      externalId: "51",
      handle: "nope",
      source: "commit_heuristic",
      confidence: "suggested",
    });
    const ids = (await call("GET", "/api/admin/people?q=bob"))
      .json()
      .items.find((p: { name: string }) => p.name === "Bob").identities;
    const id = (handle: string) => ids.find((i: { handle: string }) => i.handle === handle).id;

    expect(
      (await call("GET", "/api/admin/identities/suggested"))
        .json()
        .map((l: { handle: string; person: { name: string } }) => [l.handle, l.person.name]),
    ).toEqual([
      ["maybe", "Bob"],
      ["nope", "Bob"],
    ]);
    await call("POST", `/api/admin/identities/${id("maybe")}/confirm`);
    expect((await call("DELETE", `/api/admin/identities/${id("nope")}`)).statusCode).toBe(204);

    const after = await db.select().from(identities).where(eq(identities.personId, bob));
    expect(after.find((i) => i.handle === "maybe")).toMatchObject({
      confidence: "verified",
      source: "admin",
    });
    expect(after.find((i) => i.handle === "nope")).toBeUndefined();
  });

  it("manages API keys", async () => {
    const created = (await call("POST", "/api/admin/api-keys", { name: "billing" })).json();
    expect(created.key).toMatch(/^ntf_/);
    expect((await call("GET", "/api/admin/api-keys")).json()[0]).toMatchObject({
      name: "billing",
      revokedAt: null,
    });
    expect((await call("DELETE", "/api/admin/api-keys/billing")).statusCode).toBe(204);
    expect((await call("GET", "/api/admin/api-keys")).json()[0].revokedAt).not.toBeNull();
  });

  it("reloads the config", async () => {
    github.push("acme/notify-config", {
      "routes/x.yaml":
        "id: x\nallowed_sources: { api_keys: [ci] }\ndestinations: [{ slack: '#x' }]\ntemplate: [{ text: hi }]",
    });
    expect((await call("POST", "/api/admin/config/reload")).json()).toMatchObject({
      status: "valid",
    });
  });
});
