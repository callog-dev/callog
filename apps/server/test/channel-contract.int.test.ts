import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { routeSchema } from "@callog/config-schema";
import { TemplateRenderError } from "@callog/templates";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MessageGoneError, type Channel, type MessageRef } from "../src/channels/channel";
import { ChannelRegistry } from "../src/channels/channel-registry";
import { DB, type Db } from "../src/db/db";
import { tenants } from "../src/db/schema";
import { SlackApiError } from "../src/slack/slack-api";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { TelegramApiError } from "../src/telegram/telegram-api";
import { TelegramConnectionsService } from "../src/telegram/telegram-connections.service";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { GOOD_TELEGRAM_TOKEN, type FakeTelegram } from "./setup/fake-telegram";
import { createTestApp, createTenant } from "./setup/test-app";

/**
 * What the delivery pipeline relies on from every channel. A new channel adds its case to
 * `CASES` below and has to pass all of it.
 */
interface ChannelCase {
  id: string;
  /** A room and a person's account the fake API knows. */
  place: string;
  account: string;
  /** Makes the fake API forget a message, as if someone deleted it. */
  remove(ref: MessageRef): void;
  /** Makes the next send fail the way this channel's API does. */
  failNext(kind: "refused" | "rateLimited" | "down"): void;
}

const route = (template: unknown[]) =>
  routeSchema.parse({ id: "r", destinations: [{ slack: "#x" }], template });

const EVERY_BLOCK = [
  { header: "Failed on {{ data.branch }}" },
  { text: "**{{ data.branch }}** broke" },
  { fields: [{ label: "Suite", value: "{{ data.suite }}" }] },
  { context: "run {{ data.n }}" },
  { divider: true },
  { actions: [{ text: "Open", url: "https://ci.example/{{ data.n }}" }] },
];
const INPUT = { data: { branch: "<main>", suite: "e2e", n: 7 }, recipients: [] };

describe("channel contract (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let telegram: FakeTelegram;
  let tenantId: string;

  const CASES: ChannelCase[] = [
    {
      id: "slack",
      place: "#alerts",
      account: "UALICE",
      remove: (ref) => ref.provider === "slack" && slack.deletedTs.add(ref.ts),
      failNext: (kind) =>
        slack.failures.push(
          kind === "refused"
            ? new SlackApiError("channel_not_found")
            : kind === "rateLimited"
              ? new SlackApiError("ratelimited", 7)
              : new SlackApiError("internal_error"),
        ),
    },
    {
      id: "telegram",
      place: "-100123",
      account: "42",
      remove: (ref) => ref.provider === "telegram" && telegram.deletedIds.add(ref.messageId),
      failNext: (kind) =>
        telegram.failures.push(
          kind === "refused"
            ? new TelegramApiError(403, "Forbidden: bot was blocked by the user")
            : kind === "rateLimited"
              ? new TelegramApiError(429, "Too Many Requests", 7)
              : new TelegramApiError(502, "Bad Gateway"),
        ),
    },
  ];

  beforeAll(async () => {
    ({ app, slack, telegram } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await app.get<Db>(DB).delete(tenants);
    slack.failures = [];
    slack.deletedTs.clear();
    telegram.failures = [];
    telegram.deletedIds.clear();
    tenantId = await createTenant(app, 2500);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await app.get(TelegramConnectionsService).connect(tenantId, GOOD_TELEGRAM_TOKEN);
  });

  it("covers every registered channel", () => {
    expect(
      app
        .get(ChannelRegistry)
        .all()
        .map((c) => c.id)
        .sort(),
    ).toEqual(CASES.map((c) => c.id).sort());
  });

  describe.each(CASES)("$id", (channelCase) => {
    const { id, place, account } = channelCase;
    let channel: Channel;
    let message: unknown;
    /** Sends, and hands the ref back the way the pipeline gets it: read from the database. */
    const send = async (kind: "place" | "person", replyTo?: MessageRef) => {
      const to = { kind, id: kind === "place" ? place : account };
      const ref = await channel.send(tenantId, to, message, replyTo);
      return JSON.parse(JSON.stringify(ref)) as MessageRef;
    };
    /** The error a failed send throws. */
    const failure = async (kind: Parameters<ChannelCase["failNext"]>[0]) => {
      channelCase.failNext(kind);
      return send("place").then(
        () => {
          throw new Error("the send was expected to fail");
        },
        (err: unknown) => err,
      );
    };

    beforeEach(() => {
      channel = app.get(ChannelRegistry).get(id)!;
      message = channel.render(route(EVERY_BLOCK), INPUT, () => undefined);
    });

    it("renders a message with every block, and reports a broken template", () => {
      expect(message).toBeTruthy();
      expect(() =>
        channel.render(route([{ text: "{{ data.x | nope }}" }]), INPUT, () => undefined),
      ).toThrow(TemplateRenderError);
    });

    it("keeps data from being read as its markup", () => {
      const text = channel.render(
        route([{ text: "on {{ data.branch }}" }]),
        INPUT,
        () => undefined,
      );
      expect(JSON.stringify(text)).toContain("main");
      expect(JSON.stringify(text)).not.toContain("<main>");
    });

    it("posts to a place and to a person, returning a ref of its own", async () => {
      expect(await send("place")).toMatchObject({ provider: id });
      expect(await send("person")).toMatchObject({ provider: id });
    });

    it("replies to a message it posted", async () => {
      const root = await send("place");
      const reply = await send("place", root);
      expect(reply).toMatchObject({ provider: id });
      expect(reply).not.toEqual(root);
    });

    it("edits a message, and says so when the message is gone", async () => {
      // A channel that cannot edit leaves `edit` out, and the pipeline posts instead.
      if (!channel.edit) return;
      const ref = await send("place");
      await channel.edit(tenantId, ref, message);
      channelCase.remove(ref);
      await expect(channel.edit(tenantId, ref, message)).rejects.toBeInstanceOf(MessageGoneError);
    });

    it("tells a refusal from an outage, and passes on how long to wait", async () => {
      expect(channel.classifyError(await failure("refused"))).toMatchObject({ permanent: true });
      expect(channel.classifyError(await failure("down"))).toMatchObject({ permanent: false });
      expect(channel.classifyError(await failure("rateLimited"))).toMatchObject({
        permanent: false,
        retryAfterSeconds: 7,
      });
    });

    it("leaves errors that are not its own to the pipeline", () => {
      expect(channel.classifyError(new Error("socket hang up"))).toBeUndefined();
    });

    it("asks for a gap between messages", () => {
      expect(channel.minIntervalMs({ kind: "place", id: place })).toBeGreaterThan(0);
      expect(channel.minIntervalMs({ kind: "person", id: account })).toBeGreaterThan(0);
    });

    it("spells a place one way", () => {
      const once = channel.normalizePlace?.(place) ?? place;
      expect(channel.normalizePlace?.(once) ?? once).toBe(once);
    });
  });
});
