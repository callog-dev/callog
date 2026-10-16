import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { parseConfigTree, type Config } from "@callog/config-schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import {
  configVersions,
  deliveries,
  identities,
  idempotencyKeys,
  linkTokens,
  notifications,
  persons,
  tenants,
} from "../src/db/schema";
import { LinkTokensService } from "../src/identity/link-tokens.service";
import { PeopleService } from "../src/identity/people.service";
import { LifecycleJobs } from "../src/lifecycle/lifecycle.jobs";
import { RetentionService } from "../src/lifecycle/retention.service";
import { QueueService } from "../src/queue/queue.service";
import { RecipientResolver } from "../src/routing/recipient-resolver";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { TenantConfigService } from "../src/tenant-config/tenant-config.service";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { createTestApp, createTenant } from "./setup/test-app";

const DAY = 86_400_000;

describe("lifecycle and retention (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let admin: Awaited<ReturnType<typeof createTestApp>>["adminRequest"];
  let sendWebhook: Awaited<ReturnType<typeof createTestApp>>["sendWebhook"];
  let db: Db;
  let tenantId: string;
  let config: Config;

  beforeAll(async () => {
    ({ app, slack, adminRequest: admin, sendWebhook } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    await db.execute(sql`delete from graphile_worker._private_jobs`);
    tenantId = await createTenant(app, 1400);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    const parsed = parseConfigTree({
      "config.yaml": "retention_days: 7",
      "routes/r.yaml": `
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }]
template: [{ text: hi }]`,
    });
    if (!parsed.ok) throw new Error("bad fixture");
    config = parsed.config;
  });

  const statusOf = async (slackId: string) => {
    const [row] = await db
      .select({ status: persons.status, deactivatedAt: persons.deactivatedAt })
      .from(identities)
      .innerJoin(persons, eq(persons.id, identities.personId))
      .where(eq(identities.externalId, slackId));
    return row;
  };

  describe("Slack is the anchor of being active", () => {
    it("deactivates people deleted in Slack and reactivates them when they return", async () => {
      slack.users = [
        slack.user("U1", "alice", "alice@acme.com"),
        slack.user("U2", "bob", "bob@acme.com"),
      ];
      await admin("POST", `/admin/tenants/${tenantId}/slack/sync`);

      slack.users[1] = slack.user("U2", "bob", "bob@acme.com", { deleted: true });
      const res = await admin("POST", `/admin/tenants/${tenantId}/slack/sync`);
      expect(res.json()).toMatchObject({ users: 1, deactivated: 1, reactivated: 0 });
      expect(await statusOf("U2")).toMatchObject({
        status: "inactive",
        deactivatedAt: expect.any(Date),
      });

      const resolution = await app
        .get(RecipientResolver)
        .resolve(tenantId, config, ["slack:U1", "email:bob@acme.com"], "slack");
      expect(resolution.unmapped).toEqual(["email:bob@acme.com"]);

      slack.users[1] = slack.user("U2", "bob", "bob@acme.com");
      expect((await admin("POST", `/admin/tenants/${tenantId}/slack/sync`)).json()).toMatchObject({
        reactivated: 1,
      });
      expect(await statusOf("U2")).toMatchObject({ status: "active", deactivatedAt: null });
    });

    it("unlinks a GitHub account removed from the org but keeps the person active", async () => {
      const { personId } = await app.get(PeopleService).linkAccounts(tenantId, {
        displayName: "Alice",
        accounts: [
          { provider: "slack", externalId: "U1", source: "sync", confidence: "verified" },
          {
            provider: "github",
            externalId: "501",
            handle: "alice",
            source: "oauth",
            confidence: "verified",
          },
        ],
      });

      const res = await sendWebhook("organization", {
        action: "member_removed",
        installation: { id: 1400 },
        membership: { user: { id: 501, login: "alice" } },
        organization: { login: "acme" },
      });

      expect(res.json()).toEqual({ handled: true });
      const left = await db.select().from(identities).where(eq(identities.personId, personId));
      expect(left.map((i) => i.provider)).toEqual(["slack"]);
      expect(await statusOf("U1")).toMatchObject({ status: "active" });
    });
  });

  describe("retention", () => {
    it("deletes data past retention and keeps the rest", async () => {
      const now = new Date();
      const old = new Date(now.getTime() - 8 * DAY);
      const configs = app.get(TenantConfigService);
      const stale = await configs.recordValid(tenantId, "old", config, []);
      await db
        .update(configVersions)
        .set({ createdAt: old })
        .where(eq(configVersions.id, stale.id));
      const active = await configs.recordValid(tenantId, "new", config, []);

      const notification = async (createdAt: Date) => {
        const [n] = await db
          .insert(notifications)
          .values({
            tenantId,
            routeId: "r",
            configVersionId: active.id,
            source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
            status: "delivered",
            createdAt,
          })
          .returning();
        await db
          .insert(deliveries)
          .values({ tenantId, notificationId: n!.id, provider: "slack", destination: "#a" });
        return n!.id;
      };
      const oldId = await notification(old);
      const recentId = await notification(new Date(now.getTime() - DAY));
      await db.insert(idempotencyKeys).values([
        {
          tenantId,
          key: "old",
          requestHash: "h",
          notificationId: recentId,
          expiresAt: new Date(now.getTime() - 1000),
        },
        {
          tenantId,
          key: "live",
          requestHash: "h",
          notificationId: recentId,
          expiresAt: new Date(now.getTime() + DAY),
        },
      ]);

      const people = app.get(PeopleService);
      const long = await people.linkAccounts(tenantId, {
        displayName: "Gone long ago",
        accounts: [
          { provider: "slack", externalId: "UOLD", source: "sync", confidence: "verified" },
        ],
      });
      const recent = await people.linkAccounts(tenantId, {
        displayName: "Just left",
        accounts: [
          { provider: "slack", externalId: "UNEW", source: "sync", confidence: "verified" },
        ],
      });
      await db
        .update(persons)
        .set({ status: "inactive", deactivatedAt: new Date(now.getTime() - 31 * DAY) })
        .where(eq(persons.id, long.personId));
      await db
        .update(persons)
        .set({ status: "inactive", deactivatedAt: new Date(now.getTime() - 5 * DAY) })
        .where(eq(persons.id, recent.personId));
      const tokens = app.get(LinkTokensService);
      await tokens.issue(tenantId, recent.personId, "github");
      await db.update(linkTokens).set({ expiresAt: new Date(now.getTime() - 2 * DAY) });

      const report = (await admin("POST", "/admin/retention/run")).json();

      expect(report).toEqual({
        notifications: 1,
        configVersions: 1,
        unmappedRecipients: 0,
        persons: 1,
        idempotencyKeys: 1,
        linkTokens: 1,
      });
      const left = await db.select({ id: notifications.id }).from(notifications);
      expect(left).toEqual([{ id: recentId }]);
      expect(
        await db.select().from(deliveries).where(eq(deliveries.notificationId, oldId)),
      ).toEqual([]);
      expect(await db.select().from(identities).where(eq(identities.externalId, "UOLD"))).toEqual(
        [],
      );
      expect(await statusOf("UNEW")).toMatchObject({ status: "inactive" });
      expect((await configs.getActive(tenantId))?.versionId).toBe(active.id);

      // Running again changes nothing.
      expect(Object.values(await app.get(RetentionService).run()).every((n) => n === 0)).toBe(true);
    });
  });

  it("keeps notifications past retention that are still being delivered", async () => {
    const version = await app.get(TenantConfigService).recordValid(tenantId, "v", config, []);
    const old = (status: "processing" | "delivered") => ({
      tenantId,
      routeId: "r",
      configVersionId: version.id,
      source: { type: "api_key" as const, apiKeyId: "k", apiKeyName: "ci" },
      status,
      createdAt: new Date(Date.now() - 8 * DAY),
    });
    await db.insert(notifications).values([old("processing"), old("delivered")]);

    expect((await app.get(RetentionService).run()).notifications).toBe(1);
    expect((await db.select().from(notifications)).map((n) => n.status)).toEqual(["processing"]);
  });

  it("applies retention to tenants that uninstalled the app too", async () => {
    const version = await app.get(TenantConfigService).recordValid(tenantId, "v", config, []);
    await db.insert(notifications).values({
      tenantId,
      routeId: "r",
      configVersionId: version.id,
      source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
      status: "delivered",
      createdAt: new Date(Date.now() - 8 * DAY),
    });
    await db.update(tenants).set({ status: "inactive" }).where(eq(tenants.id, tenantId));

    expect((await app.get(RetentionService).run()).notifications).toBe(1);
  });

  describe("scheduling", () => {
    it("schedules the hourly sync and the daily retention", () => {
      const cron = app.get(QueueService).cronItems();
      expect(cron).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ task: "lifecycle.sync_all", match: "0 * * * *" }),
          expect.objectContaining({ task: "retention.cleanup" }),
        ]),
      );
    });

    it("fans the hourly sync out into per-tenant jobs", async () => {
      await app.get(LifecycleJobs).syncAll();
      const { rows } = await db.execute<{ task_identifier: string }>(
        sql`select task_identifier from graphile_worker.jobs order by task_identifier`,
      );
      expect(rows.map((r) => r.task_identifier)).toEqual(
        expect.arrayContaining(["github.identity_sync", "slack.sync"]),
      );
    });
  });
});
