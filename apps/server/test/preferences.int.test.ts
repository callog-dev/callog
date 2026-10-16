import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { deliveries, notifications, tenants } from "../src/db/schema";
import { DeliveryService } from "../src/delivery/delivery.service";
import { PeopleService, type AccountInput } from "../src/identity/people.service";
import { SlackCommands } from "../src/slack/slack-commands";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { TelegramConnectionsService } from "../src/telegram/telegram-connections.service";
import type { FakeGithub } from "./setup/fake-github";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { GOOD_TELEGRAM_TOKEN, type FakeTelegram } from "./setup/fake-telegram";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const route = (id: string, dm: boolean) => `
id: ${id}
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }]
dm: ${dm}
template: [{ text: "{{ data.msg }} {{ recipients | mention }}" }]`;

describe("personal copies and preferences (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let telegram: FakeTelegram;
  let github: FakeGithub;
  let db: Db;
  let commands: SlackCommands;
  let tenantId: string;
  let versionId: string;

  beforeAll(async () => {
    ({ app, slack, telegram, github } = await createTestApp());
    db = app.get(DB);
    commands = app.get(SlackCommands);
  });

  afterAll(async () => {
    await app?.close();
  });

  const account = (
    provider: AccountInput["provider"],
    externalId: string,
    handle?: string,
  ): AccountInput => ({
    provider,
    externalId,
    handle,
    source: "sync",
    confidence: "verified",
  });

  beforeEach(async () => {
    await db.delete(tenants);
    slack.posted = [];
    telegram.sent = [];
    tenantId = await createTenant(app, 1300);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
    github.teams.set("fe", ["alice", "bob"]);
    const people = app.get(PeopleService);
    await people.linkAccounts(tenantId, {
      displayName: "Alice",
      accounts: [
        account("slack", "UA"),
        account("github", "1", "alice"),
        account("telegram", "42", "alice_tg"),
      ],
    });
    await people.linkAccounts(tenantId, {
      displayName: "Bob",
      accounts: [account("slack", "UB"), account("github", "2", "bob")],
    });
    await people.linkAccounts(tenantId, {
      displayName: "Carol",
      accounts: [account("github", "3", "carol"), account("telegram", "43")],
    });
    versionId = (
      await activateConfig(app, tenantId, {
        "teams.yaml": "teams:\n  fe: { slack_channel: '#fe', members_from: { github_team: fe } }",
        "routes/r.yaml": route("r", true),
        "routes/quiet.yaml": route("quiet", false),
      })
    ).id;
  });

  const deliver = async (routeId: string, recipients: string[], threadKey?: string) => {
    const [n] = await db
      .insert(notifications)
      .values({
        tenantId,
        routeId,
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        data: { msg: "e2e failed" },
        recipients,
        threadKey,
      })
      .returning();
    await app.get(DeliveryService).deliver(n!.id, { attempt: 1, maxAttempts: 8 });
    return (await db.select().from(deliveries).where(eq(deliveries.notificationId, n!.id)))
      .map((d) => `${d.provider} ${d.destination} ${d.status}`)
      .sort();
  };

  const notify = (text: string, userId = "UA") => commands.handle(tenantId, { userId, text });

  it("sends each recipient one personal copy in Slack by default", async () => {
    expect(await deliver("r", ["team:fe", "github:alice"])).toEqual([
      "slack #alerts sent",
      "slack dm:UA sent",
      "slack dm:UB sent",
    ]);
    expect(slack.posted.map((p) => p.channel).sort()).toEqual(["C0ALERTS1", "DUA", "DUB"]);
  });

  it("does not send personal copies for routes without dm", async () => {
    expect(await deliver("quiet", ["team:fe"])).toEqual(["slack #alerts sent"]);
  });

  it("honours the preferred channel and falls back to the one a person has", async () => {
    expect(await notify("prefs dm telegram")).toContain("go to *Telegram*");

    expect(await deliver("r", ["github:alice", "github:carol", "github:bob"])).toEqual([
      "slack #alerts sent",
      "slack dm:UB sent",
      "telegram dm:42 sent",
      "telegram dm:43 sent",
    ]);
    expect(telegram.sent.map((s) => s.chatId).sort()).toEqual(["42", "43"]);
  });

  it("mute skips the personal copy but keeps the channel mention", async () => {
    expect(await notify("prefs mute r", "UB")).toContain("Muted personal copies of `r`");

    expect(await deliver("r", ["github:bob"])).toEqual(["slack #alerts sent"]);
    expect(slack.posted[0]!.message.text).toContain("<@UB>");

    await notify("prefs unmute r", "UB");
    expect(await deliver("r", ["github:bob"])).toContain("slack dm:UB sent");
  });

  it("keeps personal copies of one thread in one DM thread", async () => {
    await deliver("r", ["github:bob"], "t1");
    await deliver("r", ["github:bob"], "t1");
    const dms = slack.posted.filter((p) => p.channel === "DUB");
    expect(dms[1]!.message.threadTs).toBe(dms[0]!.ts);
  });

  describe("/notify prefs", () => {
    it("shows defaults and changes", async () => {
      expect(await notify("prefs")).toContain("go to *Slack*");
      expect(await notify("prefs")).toContain("*Muted:* nothing");
      await notify("prefs mute r");
      expect(await notify("prefs")).toContain("*Muted:* `r`");
    });

    it("requires a linked Telegram account for Telegram copies", async () => {
      expect(await notify("prefs dm telegram", "UB")).toContain("Link Telegram first");
    });

    it("rejects unknown routes and bad syntax", async () => {
      expect(await notify("prefs mute nope")).toContain("No route `nope`. Routes: `r`, `quiet`");
      expect(await notify("prefs dm email")).toContain("Usage:");
    });
  });
});
