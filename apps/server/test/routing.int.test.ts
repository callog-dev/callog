import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { parseConfigTree, type Config, type Ref } from "@callog/config-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { persons, tenants, unmappedRecipients } from "../src/db/schema";
import { PeopleService } from "../src/identity/people.service";
import { RecipientResolver } from "../src/routing/recipient-resolver";
import { TenantConfigService } from "../src/tenant-config/tenant-config.service";
import type { FakeGithub } from "./setup/fake-github";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { createTestApp, createTenant } from "./setup/test-app";

const CONFIG = {
  "teams.yaml": `
teams:
  frontend:
    slack_channel: "#fe"
    members_from: { github_team: frontend-gh }
  platform:
    slack_channel: "#platform"
    members_from: { github_team: platform-gh, slack_usergroup: platform }
  ghosts:
    slack_channel: "#ghosts"
    members_from: { github_team: ghosts-gh }
  address:
    slack_channel: "#address"`,
  "routes/fe-e2e-failed.yaml": `
id: fe-e2e-failed
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }]
template:
  - text: "Failed: {{ recipients | mention }}"
examples:
  - recipients: [github:bob-gh, github:octocat, team:frontend, team:address]`,
};

describe("recipient resolution (integration)", () => {
  let app: NestFastifyApplication;
  let github: FakeGithub;
  let slack: FakeSlack;
  let admin: Awaited<ReturnType<typeof createTestApp>>["adminRequest"];
  let db: Db;
  let resolver: RecipientResolver;
  let tenantId: string;
  let config: Config;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, github, slack, adminRequest: admin } = await createTestApp());
    db = app.get(DB);
    resolver = app.get(RecipientResolver);
    const parsed = parseConfigTree(CONFIG);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    config = parsed.config;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    slack.posted = [];
    tenantId = await createTenant(app, 400);
    await admin("PUT", `/admin/tenants/${tenantId}/slack`, { botToken: GOOD_SLACK_TOKEN });

    const people = app.get(PeopleService);
    const person = async (
      name: string,
      slackId: string,
      email: string,
      github?: [string, number],
    ) => {
      const { personId } = await people.linkAccounts(tenantId, {
        displayName: name,
        accounts: [
          { provider: "slack", externalId: slackId, source: "sync", confidence: "verified" },
          { provider: "email", externalId: email, source: "sync", confidence: "verified" },
        ],
      });
      if (github) {
        await people.attachAccount(tenantId, personId, {
          provider: "github",
          externalId: String(github[1]),
          handle: github[0].toLowerCase(),
          source: "admin",
          confidence: "high",
        });
      }
      ids[name] = personId;
    };
    await person("alice", "UALICE", "alice@acme.com", ["alice-gh", 1]);
    await person("bob", "UBOB", "bob@acme.com", ["Bob-GH", 2]);
    await person("carol", "UCAROL", "carol@acme.com", ["carol-gh", 3]);
    await person("dan", "UDAN", "dan@acme.com");
    github.teams.set("frontend-gh", ["Alice-GH", "bob-gh"]);
    github.teams.set("platform-gh", ["carol-gh"]);
    github.teams.set("ghosts-gh", ["nobody-gh"]);
    slack.usergroups = [{ id: "SPLAT", handle: "platform", users: ["UDAN"] }];
  });

  const resolve = (refs: Ref[]) => resolver.resolve(tenantId, config, refs, "slack");

  it("resolves people by github login (case-insensitive), email, slack id and person id", async () => {
    const r = await resolve([
      "github:BOB-gh",
      "email:Alice@acme.com",
      "slack:UDAN",
      `person:${ids.carol}` as Ref,
    ]);
    expect(r.refs.map((x) => r.mention(x.ref))).toEqual([
      ["<@UBOB>"],
      ["<@UALICE>"],
      ["<@UDAN>"],
      ["<@UCAROL>"],
    ]);
    expect(r.unmapped).toEqual([]);
  });

  it("leaves unknown people unmapped", async () => {
    const r = await resolve(["github:octocat", "email:nobody@acme.com"]);
    expect(r.unmapped).toEqual(["github:octocat", "email:nobody@acme.com"]);
    expect(r.mention("github:octocat")).toBeUndefined();
  });

  it("mentions an explicit Slack id even when it is not synced", async () => {
    const r = await resolve(["slack:UNEW"]);
    expect(r.mention("slack:UNEW")).toEqual(["<@UNEW>"]);
  });

  it("ignores suggested identities and inactive people", async () => {
    await app.get(PeopleService).attachAccount(tenantId, ids.alice!, {
      provider: "github",
      externalId: "9",
      handle: "maybe-alice",
      source: "commit_heuristic",
      confidence: "suggested",
    });
    await db.update(persons).set({ status: "inactive" }).where(eq(persons.id, ids.bob!));

    const r = await resolve(["github:maybe-alice", "github:bob-gh"]);
    expect(r.unmapped).toEqual(["github:maybe-alice", "github:bob-gh"]);
  });

  it("does not mention an explicit Slack id of an inactive person", async () => {
    await db.update(persons).set({ status: "inactive" }).where(eq(persons.id, ids.dan!));
    const r = await resolve(["slack:UDAN"]);
    expect(r.unmapped).toEqual(["slack:UDAN"]);
  });

  it("resolves person ids only within the tenant and ignores malformed ones", async () => {
    const other = await createTenant(app, 401, "other");
    const { personId: stranger } = await app.get(PeopleService).linkAccounts(other, {
      displayName: "stranger",
      accounts: [{ provider: "slack", externalId: "USTR", source: "sync", confidence: "verified" }],
    });
    const r = await resolve([`person:${stranger}` as Ref, "person:not-a-uuid" as Ref]);
    expect(r.refs.flatMap((x) => x.persons)).toEqual([]);
    expect(r.unmapped).toEqual([`person:${stranger}`, "person:not-a-uuid"]);
  });

  it("expands teams from their GitHub team, case-insensitively", async () => {
    const r = await resolve(["team:frontend"]);
    expect(r.refs[0]!.persons.map((p) => p.displayName).sort()).toEqual(["alice", "bob"]);
    expect(r.mention("team:frontend")).toEqual(["<@UALICE>", "<@UBOB>"]);
  });

  it("mentions a team with a Slack user group as the group, with members from both sources", async () => {
    const r = await resolve(["team:platform"]);
    expect(r.mention("team:platform")).toEqual(["<!subteam^SPLAT>"]);
    expect(r.refs[0]!.persons.map((p) => p.displayName).sort()).toEqual(["carol", "dan"]);
  });

  it("treats teams without resolvable members as unmapped", async () => {
    const r = await resolve(["team:ghosts", "team:address", "team:unknown", "team:constructor"]);
    expect(r.unmapped).toEqual(["team:ghosts", "team:address", "team:unknown", "team:constructor"]);
    expect([...r.reasons.values()]).toEqual([
      "nobody in the team is linked at slack",
      'team "address" has no members_from, it is only an address',
      'unknown team "unknown" (not in teams.yaml)',
      'unknown team "constructor" (not in teams.yaml)',
    ]);
  });

  it("renders, posts and records unmapped recipients through the route test endpoint", async () => {
    await app.get(TenantConfigService).recordValid(tenantId, "sha", config, []);

    const send = () =>
      admin("POST", `/admin/tenants/${tenantId}/routes/fe-e2e-failed/test`, { channel: "#alerts" });
    const res = await send();
    expect(res.statusCode).toBe(201);
    expect(res.json().unmapped).toEqual(["github:octocat", "team:address"]);
    expect(slack.posted[0]!.message.blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Failed: <@UBOB>, octocat, <@UALICE>, address" },
      },
    ]);

    await send();
    const rows = await db.select().from(unmappedRecipients).orderBy(unmappedRecipients.ref);
    expect(rows).toEqual([
      expect.objectContaining({
        ref: "github:octocat",
        provider: "slack",
        occurrences: 2,
        lastRouteId: "fe-e2e-failed",
        reason: null,
      }),
      expect.objectContaining({
        ref: "team:address",
        occurrences: 2,
        reason: 'team "address" has no members_from, it is only an address',
      }),
    ]);
  });
});
