import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { deliveries, notifications, persons, tenants, unmappedRecipients } from "../src/db/schema";
import { DeliveryService } from "../src/delivery/delivery.service";
import { NotificationsService } from "../src/notifications/notifications.service";
import { TraceService } from "../src/notifications/trace.service";
import { PeopleService, type AccountInput } from "../src/identity/people.service";
import { PreferencesService } from "../src/identity/preferences.service";
import { SlackApiError } from "../src/slack/slack-api";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { TelegramApiError } from "../src/telegram/telegram-api";
import { TelegramConnectionsService } from "../src/telegram/telegram-connections.service";
import type { FakeGithub } from "./setup/fake-github";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { GOOD_TELEGRAM_TOKEN, type FakeTelegram } from "./setup/fake-telegram";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const CONFIG = {
  "places.yaml": 'places: { lost: { slack: "#lost" } }',
  "teams.yaml": `
teams:
  ops: { slack_channel: "#ops", members_from: { github_team: ops } }
  ghosts: { slack_channel: "#ghosts", members_from: { github_team: ghosts } }`,
  "routes/r.yaml": `
id: r
allowed_sources: { api_keys: [ci] }
default_place: lost
dm: true
template: [{ text: "{{ data.msg }}" }]`,
};

describe("reaching a person another way (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let telegram: FakeTelegram;
  let github: FakeGithub;
  let db: Db;
  let tenantId: string;
  let versionId: string;

  beforeAll(async () => {
    ({ app, slack, telegram, github } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  const account = (
    provider: AccountInput["provider"],
    externalId: string,
    handle?: string,
  ): AccountInput => ({ provider, externalId, handle, source: "sync", confidence: "verified" });

  beforeEach(async () => {
    await db.delete(tenants);
    slack.posted = [];
    slack.failures = [];
    slack.channels = ["ops", "ghosts", "lost"].map((name, i) => ({ id: `C0ROOM00${i}`, name }));
    telegram.sent = [];
    telegram.failures = [];
    tenantId = await createTenant(app, 2400);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
    github.teams.set("ops", ["bob", "dan"]);
    github.teams.set("ghosts", ["nobody"]);
    const people = app.get(PeopleService);
    await people.linkAccounts(tenantId, {
      displayName: "Alice",
      accounts: [
        account("slack", "UA"),
        account("github", "1", "alice"),
        account("telegram", "42"),
      ],
    });
    await people.linkAccounts(tenantId, {
      displayName: "Bob",
      accounts: [account("slack", "UB"), account("github", "2", "bob")],
    });
    // Known to Callog, with no account in any messenger.
    await people.linkAccounts(tenantId, {
      displayName: "Dan",
      accounts: [account("github", "4", "dan")],
    });
    versionId = (await activateConfig(app, tenantId, CONFIG)).id;
  });

  /** Delivers one notification; rows in the order they were created. */
  const deliver = async (recipients: string[], attempt = 1) => {
    const [n] = await db
      .insert(notifications)
      .values({
        tenantId,
        routeId: "r",
        configVersionId: versionId,
        source: { type: "api_key", apiKeyId: "k", apiKeyName: "ci" },
        data: { msg: "backup failed" },
        recipients,
      })
      .returning();
    const status = await app.get(DeliveryService).deliver(n!.id, { attempt, maxAttempts: 8 });
    const rows = await db
      .select()
      .from(deliveries)
      .where(eq(deliveries.notificationId, n!.id))
      .orderBy(asc(deliveries.createdAt));
    return { status, rows, log: rows.map((d) => `${d.provider} ${d.destination} ${d.status}`) };
  };
  const blocked = () => new SlackApiError("cannot_dm_bot");

  it("tries the person's other messenger when the first one refuses for good", async () => {
    slack.failures = [blocked()];

    const { status, rows, log } = await deliver(["github:alice"]);

    expect(log).toEqual(["slack dm:UA failed", "telegram dm:42 sent"]);
    expect(rows[0]!.fallbackTo).toBe(rows[1]!.id);
    expect(telegram.sent.map((s) => s.chatId)).toEqual(["42"]);
    // The person was reached: the refused copy does not count against the notification.
    expect(status).toBe("delivered");
  });

  it("posts to the room of the team a person was named through, saying whom it is for", async () => {
    slack.failures = [blocked()];

    const { status, log } = await deliver(["team:ops"]);

    // Bob's copy was refused; Dan has nowhere to get one. Both end up in the team's room.
    expect(log.sort()).toEqual(["slack #ops sent", "slack dm:UB failed"]);
    expect(status).toBe("delivered");
    const post = slack.posted.find((p) => p.channel === "C0ROOM000")!;
    expect(post.message.blocks![0]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "For Dan, Bob" }],
    });
  });

  it("posts to the room of a team that has nobody to write to", async () => {
    const { status, log } = await deliver(["team:ghosts"]);

    expect(log).toEqual(["slack #ghosts sent"]);
    expect(status).toBe("delivered");
    expect(slack.posted[0]!.message.blocks).toHaveLength(1);
  });

  it("posts for people it cannot write to in the default place, next to those it can", async () => {
    const { status, log } = await deliver(["github:alice", "github:dan", "github:ghost"]);

    expect(log.sort()).toEqual(["slack #lost sent", "slack dm:UA sent"]);
    expect(status).toBe("delivered");
    const post = slack.posted.find((p) => p.channel === "C0ROOM002")!;
    expect(post.message.blocks![0]).toMatchObject({ elements: [{ text: "For Dan, ghost" }] });
    expect(new Set((await db.select().from(unmappedRecipients)).map((u) => u.ref))).toEqual(
      new Set(["github:dan", "github:ghost"]),
    );
  });

  it("explains what happened to each recipient", async () => {
    const [bob] = await db.select().from(persons).where(eq(persons.displayName, "Bob"));
    await app.get(PreferencesService).mute(tenantId, bob!.id, "r");
    slack.failures = [blocked()];

    const { rows } = await deliver([
      "github:alice",
      "github:bob",
      "github:dan",
      "github:ghost",
      "team:ghosts",
    ]);
    const forSender = await app.get(NotificationsService).get(tenantId, rows[0]!.notificationId);

    const [notification] = await db.select().from(notifications);
    const trace = await app.get(TraceService).of(notification!);

    expect(trace.notes.map((n) => `${n.recipient.name}: ${n.note}`).sort()).toEqual([
      "Bob: muted",
      "Dan: no_account",
      "ghost: unknown",
      "ghosts: empty_team",
    ]);
    const shown = trace.deliveries.map((d) => ({
      to: `${d.provider} ${d.destination} ${d.status}`,
      for: d.for.map((recipient) => recipient.name),
      replaced: d.fallbackTo !== null,
    }));
    expect(shown).toEqual(
      expect.arrayContaining([
        { to: "slack dm:UA failed", for: ["Alice"], replaced: true },
        { to: "telegram dm:42 sent", for: ["Alice"], replaced: false },
        { to: "slack #ghosts sent", for: [], replaced: false },
        { to: "slack #lost sent", for: ["Dan", "ghost"], replaced: false },
      ]),
    );
    expect(shown).toHaveLength(4);

    // A sender learns which of its own refs led nowhere, and nothing about the people.
    expect(forSender.status).toBe("delivered");
    expect(forSender.notes.map((n) => `${n.recipient}: ${n.note}`).sort()).toEqual([
      "github:ghost: unknown",
      "team:ghosts: empty_team",
    ]);
    expect(JSON.stringify(forSender)).not.toMatch(/Alice|Bob|Dan|muted/);
  });

  it("falls back when the attempts run out, not only on a refusal", async () => {
    slack.failures = [new SlackApiError("internal_error")];

    const { status, log } = await deliver(["github:alice"], 8);

    expect(log).toEqual(["slack dm:UA failed", "telegram dm:42 sent"]);
    expect(status).toBe("delivered");
  });

  it("does not send again what a fallback took over, when the notification is retried", async () => {
    slack.failures = [blocked()];
    const { rows } = await deliver(["github:alice"]);
    await db.update(notifications).set({ status: "partially_failed" });

    await app
      .get(NotificationsService)
      .retry(tenantId, rows[0]!.notificationId, { personId: null, githubLogin: "admin" });

    const after = await db.select().from(deliveries).orderBy(asc(deliveries.createdAt));
    expect(after.map((d) => d.status)).toEqual(["failed", "sent"]);
  });

  it("ends in the default place, and fails only when that is refused too", async () => {
    const refuseBoth = () => {
      slack.failures = [blocked()];
      telegram.failures = [new TelegramApiError(403, "Forbidden: bot was blocked by the user")];
    };
    refuseBoth();
    const reached = await deliver(["github:alice"]);
    expect(reached.log).toEqual([
      "slack dm:UA failed",
      "telegram dm:42 failed",
      "slack #lost sent",
    ]);
    expect(reached.status).toBe("delivered");

    refuseBoth();
    slack.failures.push(new SlackApiError("not_in_channel"));
    const lost = await deliver(["github:alice"]);
    expect(lost.log.at(-1)).toBe("slack #lost failed");
    expect(lost.status).toBe("failed");
  });
});
