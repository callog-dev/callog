import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { deliveries, notifications, tenants } from "../src/db/schema";
import { PeopleService } from "../src/identity/people.service";
import { TenantConfigService } from "../src/tenant-config/tenant-config.service";
import type { FakeGithub } from "./setup/fake-github";
import { GOOD_SLACK_TOKEN } from "./setup/fake-slack";
import { activateConfig, createTenant, createTestApp } from "./setup/test-app";
import { webLogin } from "./setup/web-login";

const CONFIG = {
  "routes/e2e.yaml": `
id: e2e
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }]
template: [{ text: hi }]`,
};

describe("first sign-in and the Getting started checklist (integration)", () => {
  let app: NestFastifyApplication;
  let github: FakeGithub;
  let githubOAuthUsers: Map<string, { id: number; login: string }>;
  let adminRequest: Awaited<ReturnType<typeof createTestApp>>["adminRequest"];
  let db: Db;
  let tenantId: string;
  /** Unique per test: the org role of a login is cached for a minute. */
  let owner: { id: number; login: string };
  let seq = 0;

  const call = (method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    ({ app, github, githubOAuthUsers, adminRequest } = await createTestApp());
    db = app.get(DB);
  });
  afterAll(() => app?.close());

  beforeEach(async () => {
    await db.delete(tenants);
    seq += 1;
    owner = { id: 5000 + seq, login: `owner-${seq}` };
    github.members = [owner, { id: 6000 + seq, login: `member-${seq}` }];
    github.orgAdmins.clear();
    github.orgAdmins.add(owner.login);
    tenantId = await createTenant(app, 3000 + seq);
  });

  it("lets an org owner in before Slack exists, to the admin pages only", async () => {
    const cookie = await webLogin(app, githubOAuthUsers, owner);

    expect((await call("GET", "/api/me", cookie)).json()).toMatchObject({
      person: null,
      githubLogin: owner.login,
      org: "acme",
      isAdmin: true,
      identities: [],
      preferences: null,
    });
    expect((await call("GET", "/api/admin/status", cookie)).statusCode).toBe(200);
    expect((await call("GET", "/api/routes", cookie)).statusCode).toBe(200);
    const mute = await call("PUT", "/api/me/mutes/e2e", cookie);
    expect(mute.statusCode).toBe(403);
    expect(mute.json().message).toContain("/notify link github");
  });

  it("keeps an unlinked member out", async () => {
    await expect(
      webLogin(app, githubOAuthUsers, { id: 6000 + seq, login: `member-${seq}` }),
    ).rejects.toThrow(/not linked to anyone here yet/);
  });

  it("records the owner's login as the actor of role changes", async () => {
    const { personId: bob } = await app.get(PeopleService).linkAccounts(tenantId, {
      displayName: "Bob",
      accounts: [
        {
          provider: "slack",
          externalId: "UB",
          handle: "bob",
          source: "sync",
          confidence: "verified",
        },
      ],
    });
    const cookie = await webLogin(app, githubOAuthUsers, owner);
    expect((await call("POST", "/api/admin/admins", cookie, { personId: bob })).statusCode).toBe(
      201,
    );
    const { audit } = (await call("GET", "/api/admin/admins", cookie)).json();
    expect(audit[0]).toMatchObject({
      action: "admin.granted",
      actor: `@${owner.login}`,
      subject: "Bob",
    });
  });

  it("signs a linked owner in as their person", async () => {
    await app.get(PeopleService).linkAccounts(tenantId, {
      displayName: "Olga",
      accounts: [
        {
          provider: "github",
          externalId: String(owner.id),
          handle: owner.login,
          source: "oauth",
          confidence: "verified",
        },
      ],
    });
    const cookie = await webLogin(app, githubOAuthUsers, owner);
    expect((await call("GET", "/api/me", cookie)).json()).toMatchObject({
      person: { name: "Olga" },
      isAdmin: true,
    });
  });

  it("shows why the latest config push was rejected", async () => {
    const cookie = await webLogin(app, githubOAuthUsers, owner);
    const issue = (n: number) => ({
      file: "routes/hello.yaml",
      path: ["destinations"],
      message: `bad ${n}`,
    });
    await app
      .get(TenantConfigService)
      .recordInvalid(tenantId, "sha-bad", [1, 2, 3, 4].map(issue), []);
    const { steps } = (await call("GET", "/api/admin/onboarding", cookie)).json();
    expect(steps.config).toMatchObject({ done: false, rejected: true });
    expect(steps.config.errors.map((e: { message: string }) => e.message)).toEqual([
      "bad 1",
      "bad 2",
      "bad 3",
    ]);
  });

  it("walks the checklist from a fresh install to complete", async () => {
    const cookie = await webLogin(app, githubOAuthUsers, owner);
    const checklist = async () => (await call("GET", "/api/admin/onboarding", cookie)).json();

    expect(await checklist()).toEqual({
      steps: {
        githubApp: { done: true, org: "acme", installationId: 3000 + seq },
        slack: { done: false, team: null },
        linkGithub: { done: false },
        telegram: { done: false, optional: true, bot: null },
        config: { done: false, repo: "acme/notify-config", rejected: false, errors: [] },
        firstNotification: { done: false },
      },
      complete: false,
    });

    await adminRequest("PUT", `/admin/tenants/${tenantId}/slack`, { botToken: GOOD_SLACK_TOKEN });
    const version = await activateConfig(app, tenantId, CONFIG);
    const [n] = await db
      .insert(notifications)
      .values({
        tenantId,
        routeId: "e2e",
        configVersionId: version.id,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        status: "delivered",
      })
      .returning();
    await db.insert(deliveries).values({
      tenantId,
      notificationId: n!.id,
      provider: "slack",
      destination: "#alerts",
      status: "sent",
    });
    const almost = await checklist();
    expect(almost.steps).toMatchObject({
      slack: { done: true },
      config: { done: true },
      firstNotification: { done: true },
      linkGithub: { done: false },
    });
    expect(almost.complete).toBe(false);

    // The owner links GitHub (as /notify link github would) and signs in again as a person.
    await app.get(PeopleService).linkAccounts(tenantId, {
      displayName: "Olga",
      accounts: [
        {
          provider: "github",
          externalId: String(owner.id),
          handle: owner.login,
          source: "oauth",
          confidence: "verified",
        },
      ],
    });
    const linked = await webLogin(app, githubOAuthUsers, owner);
    const done = (await call("GET", "/api/admin/onboarding", linked)).json();
    expect(done.steps.linkGithub).toEqual({ done: true });
    expect(done.complete).toBe(true);
  });
});
