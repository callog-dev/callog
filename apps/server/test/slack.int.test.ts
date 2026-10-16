import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, type Db } from "../src/db/db";
import { identities, persons, slackConnections, tenants } from "../src/db/schema";
import { PeopleService } from "../src/identity/people.service";
import { SlackApiError } from "../src/slack/slack-api";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { SlackCommands } from "../src/slack/slack-commands";
import { SlackEvents } from "../src/slack/slack-events";
import { SlackSocketRunner } from "../src/slack/slack-socket";
import { SlackSender } from "../src/slack/slack-sender";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { createTestApp, createTenant } from "./setup/test-app";

describe("Slack (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let admin: Awaited<ReturnType<typeof createTestApp>>["adminRequest"];
  let db: Db;
  let tenantId: string;

  beforeAll(async () => {
    ({ app, slack, adminRequest: admin } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    slack.users = [];
    slack.posted = [];
    slack.failures = [];
    slack.channels = [{ id: "C0ALERTS1", name: "alerts" }];
    slack.listChannelsCalls = 0;
    tenantId = await createTenant(app, 900);
  });

  const base = () => `/admin/tenants/${tenantId}/slack`;
  const connect = () => admin("PUT", base(), { botToken: GOOD_SLACK_TOKEN });
  const identitiesOf = (personId: string) =>
    db
      .select({ provider: identities.provider, externalId: identities.externalId })
      .from(identities)
      .where(eq(identities.personId, personId));

  describe("connect", () => {
    it("rejects tokens Slack does not accept", async () => {
      const res = await admin("PUT", base(), { botToken: "xoxb-bad" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("invalid_auth");
    });

    it("stores the token encrypted and returns the workspace", async () => {
      const res = await connect();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ teamId: "T0TEST", teamName: "test-team", botUserId: "U0BOT" });
      const [row] = await db.select().from(slackConnections);
      expect(row!.botTokenEncrypted).not.toContain(GOOD_SLACK_TOKEN);
      expect(row!.botTokenEncrypted).toMatch(/^v1\./);
    });
  });

  describe("users sync", () => {
    beforeEach(async () => {
      await connect();
    });

    it("creates persons with verified slack and email identities for active humans", async () => {
      slack.users = [
        slack.user("U1", "alice", "Alice@Acme.com"),
        slack.user("U2", "bob"),
        slack.user("U3", "botty", "bot@acme.com", { isBot: true }),
        slack.user("U4", "gone", "gone@acme.com", { deleted: true }),
      ];

      const res = await admin("POST", `${base()}/sync`);
      expect(res.json()).toEqual({
        users: 2,
        deactivated: 0,
        reactivated: 0,
        createdPersons: 2,
        withoutEmail: 1,
        conflicts: 0,
      });

      const all = await db.select().from(persons);
      expect(all.map((p) => p.displayName).sort()).toEqual(["alice", "bob"]);
      const alice = all.find((p) => p.displayName === "alice")!;
      expect(await identitiesOf(alice.id)).toEqual(
        expect.arrayContaining([
          { provider: "slack", externalId: "U1" },
          { provider: "email", externalId: "alice@acme.com" },
        ]),
      );
      const rows = await db.select().from(identities).where(eq(identities.personId, alice.id));
      expect(rows.every((r) => r.confidence === "verified" && r.source === "sync")).toBe(true);
    });

    it("is idempotent and picks up renamed users", async () => {
      slack.users = [slack.user("U1", "alice", "alice@acme.com")];
      await admin("POST", `${base()}/sync`);
      slack.users = [slack.user("U1", "alice.smith", "alice@acme.com")];
      const res = await admin("POST", `${base()}/sync`);

      expect(res.json()).toMatchObject({ createdPersons: 0 });
      const all = await db.select().from(persons);
      expect(all).toHaveLength(1);
      expect(all[0]!.displayName).toBe("alice.smith");
      const [slackIdentity] = await db
        .select()
        .from(identities)
        .where(and(eq(identities.provider, "slack"), eq(identities.externalId, "U1")));
      expect(slackIdentity!.handle).toBe("alice.smith");
    });

    it("joins an existing person found by work email", async () => {
      const people = app.get(PeopleService);
      const { personId } = await people.linkAccounts(tenantId, {
        displayName: "Alice (linked by an admin)",
        accounts: [
          {
            provider: "email",
            externalId: "alice@acme.com",
            source: "admin",
            confidence: "high",
          },
          {
            provider: "github",
            externalId: "alice-personal",
            source: "admin",
            confidence: "high",
          },
        ],
      });
      slack.users = [slack.user("U1", "alice", "alice@acme.com")];

      await admin("POST", `${base()}/sync`);

      expect(await db.select().from(persons)).toHaveLength(1);
      expect(await identitiesOf(personId)).toHaveLength(3);
      // The Slack sync verified the email that was only "high" before.
      const [email] = await db.select().from(identities).where(eq(identities.provider, "email"));
      expect(email).toMatchObject({ confidence: "verified", source: "sync" });
    });

    it("never merges two existing persons", async () => {
      const people = app.get(PeopleService);
      const a = await people.linkAccounts(tenantId, {
        displayName: "A",
        accounts: [{ provider: "slack", externalId: "U1", source: "sync", confidence: "verified" }],
      });
      const b = await people.linkAccounts(tenantId, {
        displayName: "B",
        accounts: [
          { provider: "email", externalId: "x@acme.com", source: "admin", confidence: "verified" },
        ],
      });
      slack.users = [slack.user("U1", "a", "x@acme.com")];

      const res = await admin("POST", `${base()}/sync`);

      expect(res.json()).toMatchObject({ conflicts: 1 });
      expect(await identitiesOf(a.personId)).toEqual([{ provider: "slack", externalId: "U1" }]);
      expect(await identitiesOf(b.personId)).toEqual([
        { provider: "email", externalId: "x@acme.com" },
      ]);
    });

    it("does not downgrade confidence", async () => {
      const people = app.get(PeopleService);
      const account = { provider: "github" as const, externalId: "octo" };
      const { personId } = await people.linkAccounts(tenantId, {
        displayName: "O",
        accounts: [{ ...account, source: "oauth", confidence: "verified" }],
      });
      await people.linkAccounts(tenantId, {
        displayName: "O",
        accounts: [{ ...account, source: "commit_heuristic", confidence: "suggested" }],
      });
      const [row] = await db.select().from(identities).where(eq(identities.personId, personId));
      expect(row).toMatchObject({ confidence: "verified", source: "oauth" });
    });
  });

  describe("sending", () => {
    beforeEach(async () => {
      await connect();
    });

    it("resolves #channel names and caches them", async () => {
      const res = await admin("POST", `${base()}/test-message`, { channel: "#alerts", text: "hi" });
      expect(res.statusCode).toBe(201);
      await app.get(SlackSender).postToChannel(tenantId, "#alerts", { text: "again" });

      expect(slack.posted.map((p) => p.channel)).toEqual(["C0ALERTS1", "C0ALERTS1"]);
      expect(slack.listChannelsCalls).toBe(1);
    });

    it("re-resolves a channel name whose cached id was archived (recreated channel)", async () => {
      const sender = app.get(SlackSender);
      await sender.postToChannel(tenantId, "#alerts", { text: "before" });
      slack.channels = [{ id: "C0NEWALRT", name: "alerts" }];
      slack.failures = [new SlackApiError("is_archived")];

      await sender.postToChannel(tenantId, "#alerts", { text: "after" });
      expect(slack.posted.map((p) => p.channel)).toEqual(["C0ALERTS1", "C0NEWALRT"]);
      expect(slack.listChannelsCalls).toBe(2);
    });

    it("does not list all channels again for every message to an unknown one", async () => {
      const sender = app.get(SlackSender);
      for (let i = 0; i < 3; i++) {
        await expect(sender.postToChannel(tenantId, "#nope", { text: "x" })).rejects.toThrow(
          /channel_not_found/,
        );
      }
      expect(slack.listChannelsCalls).toBe(1);
    });

    it("reports unknown channels", async () => {
      const res = await admin("POST", `${base()}/test-message`, { channel: "#nope", text: "hi" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("channel_not_found");
    });

    it("sends direct messages", async () => {
      await admin("POST", `${base()}/test-message`, { slackUserId: "U1", text: "hi" });
      expect(slack.posted).toEqual([
        { channel: "DU1", message: { text: "hi" }, ts: expect.any(String) },
      ]);
    });

    it("finds user groups by handle", async () => {
      slack.usergroups = [{ id: "S1", handle: "frontend", users: ["U1", "U2"] }];
      const sender = app.get(SlackSender);
      expect(await sender.usergroup(tenantId, "@frontend")).toEqual(slack.usergroups[0]);
      await expect(sender.usergroup(tenantId, "backend")).rejects.toThrow(/usergroup_not_found/);
    });
  });

  it("retries a Socket Mode client whose start failed and follows app token changes", async () => {
    const runner = app.get(SlackSocketRunner);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    slack.sockets = [];
    slack.socketFailures.push(new Error("getaddrinfo ENOTFOUND"));
    try {
      // Connected through the API (another process): only reconcile sees it.
      await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN, "xapp-1");
      await runner.reconcile();
      await settle();
      expect(slack.sockets.map((s) => s.starts)).toEqual([1]);
      await runner.reconcile(); // the failed start is retried with a new client
      await settle();
      expect(slack.sockets.map((s) => s.starts)).toEqual([1, 1]);
      await runner.reconcile(); // connected: nothing to do
      expect(slack.sockets).toHaveLength(2);

      await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN, "xapp-2");
      await runner.reconcile();
      expect(slack.sockets[1]!.disconnected).toBe(true);
      expect(slack.sockets.at(-1)!.appToken).toBe("xapp-2");
    } finally {
      await runner.onApplicationShutdown();
    }
  });

  it("routes a /notify that arrives on another tenant's socket by its workspace", async () => {
    const runner = app.get(SlackSocketRunner);
    slack.sockets = [];
    const handle = vi.spyOn(app.get(SlackCommands), "handle").mockResolvedValue("ok");
    try {
      const connections = app.get(SlackConnectionsService);
      await connections.connect(tenantId, GOOD_SLACK_TOKEN, "xapp-1");
      const other = await createTenant(app, 901, "other");
      await connections.connect(other, GOOD_SLACK_TOKEN);
      await db
        .update(slackConnections)
        .set({ teamId: "T0OTHER" })
        .where(eq(slackConnections.tenantId, other));
      await runner.reconcile(); // only this tenant has an app token: one socket

      const ack = vi.fn(async () => undefined);
      const command = (team_id: string) =>
        slack.sockets[0]!.handlers.get("slash_commands")!({
          body: { team_id, user_id: "U1", text: "whoami" },
          ack,
        });
      await command("T0OTHER");
      expect(handle).toHaveBeenLastCalledWith(other, { userId: "U1", text: "whoami" });
      await command("T0UNKNOWN");
      expect(handle).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "This workspace is not connected." }),
      );
    } finally {
      await runner.onApplicationShutdown();
      handle.mockRestore();
    }
  });

  it("throttles directory syncs triggered by user_change events", async () => {
    const syncJobs = async () =>
      (
        await db.execute<{ run_at: Date }>(
          sql`select run_at from graphile_worker.jobs
              where task_identifier = 'slack.sync' and key = ${`slack.sync:${tenantId}`}`,
        )
      ).rows;
    const events = app.get(SlackEvents);
    await events.requestSync(tenantId, { throttled: true });
    const [first] = await syncJobs();
    expect(new Date(first!.run_at).getTime()).toBeGreaterThan(Date.now() + 30_000);

    // A burst of profile changes does not push the sync further out or add jobs.
    await events.requestSync(tenantId, { throttled: true });
    expect(await syncJobs()).toEqual([first]);

    // An explicit sync (admin, hourly) still runs now.
    await events.requestSync(tenantId);
    expect(new Date((await syncJobs())[0]!.run_at).getTime()).toBeLessThan(Date.now() + 5_000);
  });

  it("survives two syncs attaching the same account at once", async () => {
    const people = app.get(PeopleService);
    const person = async (name: string) =>
      (
        await people.linkAccounts(tenantId, {
          displayName: name,
          accounts: [
            {
              provider: "email",
              externalId: `${name}@acme.com`,
              source: "sync",
              confidence: "verified",
            },
          ],
        })
      ).personId;
    const [a, b] = [await person("a"), await person("b")];
    for (let i = 0; i < 10; i++) {
      const account = {
        provider: "github",
        externalId: String(1000 + i),
        source: "commit_heuristic",
        confidence: "high",
      } as const;
      const outcomes = await Promise.all([
        people.attachAccount(tenantId, a, account),
        people.attachAccount(tenantId, b, account),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["added", "conflict"]);
    }
  });

  it("refuses to send when Slack is not connected", async () => {
    const res = await admin("POST", `${base()}/test-message`, { channel: "#alerts", text: "hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not_connected");
  });
});
