import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { tenants } from "../src/db/schema";
import { InstallationEvents } from "../src/tenants/installation-events";
import type { FakeGithub } from "./setup/fake-github";
import { createTestApp } from "./setup/test-app";

describe("GitHub webhooks (integration)", () => {
  let app: NestFastifyApplication;
  let db: Db;
  let fakeGithub: FakeGithub;
  let send: Awaited<ReturnType<typeof createTestApp>>["sendWebhook"];

  beforeAll(async () => {
    ({ app, github: fakeGithub, sendWebhook: send } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
  });

  const installationEvent = (action: string, id = 42, type = "Organization", accountId = 900) => ({
    action,
    installation: { id, account: { id: accountId, login: "acme-org", type } },
  });

  const tenantFor = async (installationId: number) =>
    (await db.select().from(tenants).where(eq(tenants.githubInstallationId, installationId)))[0];

  it("rejects an invalid signature with 401", async () => {
    const res = await send("installation", installationEvent("created"), "wrong");
    expect(res.statusCode).toBe(401);
    expect(await tenantFor(42)).toBeUndefined();
  });

  it("creates a tenant on installation.created", async () => {
    const res = await send("installation", installationEvent("created"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ handled: true });
    expect(await tenantFor(42)).toMatchObject({
      githubOrgLogin: "acme-org",
      status: "active",
    });
  });

  it("is idempotent for redelivered events", async () => {
    await send("installation", installationEvent("created"));
    await send("installation", installationEvent("created"));
    expect(await db.select().from(tenants)).toHaveLength(1);
  });

  it("deactivates on deleted and reactivates the same tenant on reinstall", async () => {
    await send("installation", installationEvent("created"));
    const created = await tenantFor(42);

    await send("installation", installationEvent("deleted"));
    expect(await tenantFor(42)).toMatchObject({ id: created!.id, status: "inactive" });

    await send("installation", installationEvent("unsuspend"));
    expect(await tenantFor(42)).toMatchObject({ id: created!.id, status: "active" });
  });

  it("reuses the org's tenant when the app is uninstalled and installed again", async () => {
    await send("installation", installationEvent("created", 42));
    const created = await tenantFor(42);
    await send("installation", installationEvent("deleted", 42));

    // A new installation gets a new id; the org (account id) is the same.
    await send("installation", installationEvent("created", 43));
    expect(await db.select().from(tenants)).toHaveLength(1);
    expect(await tenantFor(43)).toMatchObject({ id: created!.id, status: "active" });

    // Another org that registered the same login is a different tenant.
    await send("installation", installationEvent("deleted", 43));
    await send("installation", installationEvent("created", 44, "Organization", 901));
    expect(await tenantFor(44)).toMatchObject({ status: "active" });
    expect((await tenantFor(44))!.id).not.toBe(created!.id);
  });

  it("ignores installations on user accounts", async () => {
    await send("installation", installationEvent("created", 7, "User"));
    expect(await tenantFor(7)).toBeUndefined();
  });

  it("acknowledges unhandled events without doing anything", async () => {
    const res = await send("star", { action: "created" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ handled: false });
  });

  it("reconciles tenants with the current installations", async () => {
    await send("installation", installationEvent("created", 1, "Organization", 801));
    await send("installation", installationEvent("created", 2, "Organization", 900));
    fakeGithub.installations = [
      {
        id: 2,
        accountId: 900,
        accountLogin: "renamed-org",
        accountType: "Organization",
        suspended: false,
      },
      {
        id: 3,
        accountId: 902,
        accountLogin: "new-org",
        accountType: "Organization",
        suspended: false,
      },
      { id: 4, accountId: 903, accountLogin: "someone", accountType: "User", suspended: false },
    ];

    await app.get(InstallationEvents).reconcile();

    expect(await tenantFor(1)).toMatchObject({ status: "inactive" });
    expect(await tenantFor(2)).toMatchObject({ status: "active", githubOrgLogin: "renamed-org" });
    expect(await tenantFor(3)).toMatchObject({ status: "active", githubOrgLogin: "new-org" });
    expect(await tenantFor(4)).toBeUndefined();
  });
});
