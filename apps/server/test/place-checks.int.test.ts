import { parseConfigTree } from "@callog/config-schema";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, type Db } from "../src/db/db";
import { tenants } from "../src/db/schema";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { PlaceChecks } from "../src/channels/place-checks";
import { SlackSender } from "../src/slack/slack-sender";
import { TenantConfigService } from "../src/tenant-config/tenant-config.service";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { activateConfig, createTenant, createTestApp, eventually } from "./setup/test-app";

describe("place checks (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let db: Db;
  let tenantId: string;
  let places: PlaceChecks;

  beforeAll(async () => {
    ({ app, slack } = await createTestApp());
    db = app.get(DB);
    places = app.get(PlaceChecks);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    await db.execute(sql`delete from graphile_worker._private_jobs`);
    slack.posted = [];
    slack.channels = [{ id: "C0ALERTS1", name: "alerts" }];
    slack.resetChannelListing();
    slack.channelInfoCalls = 0;
    tenantId = await createTenant(app, 900);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const activate = (yaml: string) => activateConfig(app, tenantId, { "places.yaml": yaml });
  const issuesIn = async (a: NestFastifyApplication) =>
    (await a.get(TenantConfigService).getActive(tenantId))!.placeIssues;
  const issues = () => issuesIn(app);
  const post = (channel: string) =>
    app.get(SlackSender).postToChannel(tenantId, channel, { text: "hi" });
  const checkJobs = async () =>
    (
      await db.execute(
        sql`select count(*)::int as count from graphile_worker.jobs
            where task_identifier = 'places.check'`,
      )
    ).rows[0]!.count;

  it("schedules a check of the places when a config becomes active", async () => {
    await db.execute(sql`delete from graphile_worker._private_jobs`);

    await activate('places: { feed: { slack: "#alerts" } }');

    expect(await checkJobs()).toBe(1);
  });

  it("resolves every named place, so that sending lists nothing", async () => {
    slack.publicChannels = [{ id: "C0DEPLOYS", name: "deploys" }];
    await activate('places: { feed: { slack: "#alerts" }, ship: { slack: deploys } }');

    await places.check(tenantId);
    slack.channelPages = [];
    await post("#alerts");
    await post("#deploys");

    expect(await issues()).toEqual({});
    expect(slack.posted.map((p) => p.channel)).toEqual(["C0ALERTS1", "C0DEPLOYS"]);
    expect(slack.channelPages).toEqual([]);
  });

  it("names the place whose channel does not exist or is closed to the bot", async () => {
    await activate('places: { feed: { slack: "#alerts" }, gone: { slack: "#nope" } }');

    await places.check(tenantId);

    expect(await issues()).toEqual({
      gone: { level: "error", message: expect.stringContaining("#nope was not found") },
    });
  });

  it("keeps the warnings the config itself was loaded with", async () => {
    const parsed = parseConfigTree({ "places.yaml": 'places: { gone: { slack: "#nope" } }' });
    if (!parsed.ok) throw new Error("bad fixture");
    const warning = { file: "places.yaml", path: [], message: "something minor" };
    const version = await app
      .get(TenantConfigService)
      .recordValid(tenantId, "sha", parsed.config, [warning]);

    await places.check(tenantId);

    expect(Object.keys(await issues())).toEqual(["gone"]);
    expect((await app.get(TenantConfigService).latest(tenantId))!.errors).toMatchObject({
      warnings: [warning],
    });
    expect(version.id).toBe((await app.get(TenantConfigService).getActive(tenantId))!.versionId);
  });

  it("clears the problem once the channel appears", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await activate('places: { gone: { slack: "#nope" } }');
    await places.check(tenantId);
    slack.channels.push({ id: "C0NOPE001", name: "nope" });
    vi.advanceTimersByTime(61_000);

    await places.check(tenantId);

    expect(await issues()).toEqual({});
  });

  it("leaves places given by channel id and Telegram places alone", async () => {
    await activate('places: { byid: { slack: C0PUB04999 }, tg: { telegram: "-1001" } }');

    await places.check(tenantId);

    expect(await issues()).toEqual({});
    expect(slack.channelPages).toEqual([]);
    expect(slack.channelInfoCalls).toBe(0);
  });

  it("warns instead of failing when Slack rate limits the lookup, and asks to be retried", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    slack.channelRateLimit = { pages: 0, retryAfter: 120 };
    await activate('places: { feed: { slack: "#alerts" } }');

    expect(await places.check(tenantId)).toEqual({ retry: true });
    expect(await issues()).toEqual({
      feed: { level: "warning", message: expect.stringContaining("rate limit") },
    });

    slack.channelRateLimit = undefined;
    vi.advanceTimersByTime(121_000);
    expect(await places.check(tenantId)).toEqual({ retry: false });
    expect(await issues()).toEqual({});
  });

  it("notices that a channel it knew was renamed or archived", async () => {
    await activate('places: { feed: { slack: "#alerts" } }');
    await places.check(tenantId);
    slack.channels = [{ id: "C0ALERTS1", name: "alerts-prod" }];

    await places.check(tenantId);

    expect(await issues()).toEqual({
      feed: { level: "error", message: expect.stringContaining("#alerts was not found") },
    });
  });

  it("follows the name to a new channel when the old one was renamed away", async () => {
    await activate('places: { feed: { slack: "#alerts" } }');
    await places.check(tenantId);
    slack.channels = [
      { id: "C0ALERTS1", name: "alerts-old" },
      { id: "C0ALERTS2", name: "alerts" },
    ];

    await places.check(tenantId);
    await post("#alerts");

    expect(await issues()).toEqual({});
    expect(slack.posted.map((p) => p.channel)).toEqual(["C0ALERTS2"]);
  });

  it("checks a channel it already knows with one request instead of a listing", async () => {
    await activate('places: { feed: { slack: "#alerts" } }');
    await places.check(tenantId);
    slack.channelPages = [];

    await places.check(tenantId);

    expect(slack.channelPages).toEqual([]);
    expect(slack.channelInfoCalls).toBe(1);
  });

  it("does nothing while Slack is not connected", async () => {
    await app.get(SlackConnectionsService).disconnect(tenantId);
    await activate('places: { feed: { slack: "#alerts" } }');

    expect(await places.check(tenantId)).toEqual({ retry: false });
    expect(await issues()).toEqual({});
  });

  it("shows the problem by itself once the config is loaded, in a worker process", async () => {
    const worker = await createTestApp({ role: "all" });
    try {
      await worker.app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
      await activateConfig(worker.app, tenantId, {
        "places.yaml": 'places: { gone: { slack: "#nope" } }',
      });

      const found = await eventually(async () => (await issuesIn(worker.app)).gone);
      expect(found.message).toContain("#nope was not found");
    } finally {
      await worker.app.close();
    }
  });
});
