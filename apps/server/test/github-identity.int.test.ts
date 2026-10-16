import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { identities, tenants } from "../src/db/schema";
import { PeopleService } from "../src/identity/people.service";
import type { FakeCommit, FakeGithub, FakeUser } from "./setup/fake-github";
import { createTestApp } from "./setup/test-app";

const ORG = "acme";
const alice: FakeUser = { login: "Alice-Personal", id: 101 };
const bob: FakeUser = { login: "bobby", id: 102 };
const carol: FakeUser = { login: "carol", id: 103 };

describe("GitHub identity sync (integration)", () => {
  let app: NestFastifyApplication;
  let github: FakeGithub;
  let admin: Awaited<ReturnType<typeof createTestApp>>["adminRequest"];
  let db: Db;
  let people: PeopleService;
  let tenantId: string;

  beforeAll(async () => {
    ({ app, github, adminRequest: admin } = await createTestApp());
    db = app.get(DB);
    people = app.get(PeopleService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    github.members = [alice, bob, carol];
    github.users = [];
    github.commits = new Map();
    github.commitErrors.clear();
    github.verifiedDomainEmails = undefined;
    const [tenant] = await db
      .insert(tenants)
      .values({ githubInstallationId: 300, githubOrgLogin: ORG })
      .returning();
    tenantId = tenant!.id;
  });

  /** A Slack-anchored person with a verified work email. */
  const slackPerson = async (name: string, email: string) =>
    (
      await people.linkAccounts(tenantId, {
        displayName: name,
        accounts: [
          { provider: "slack", externalId: `U-${name}`, source: "sync", confidence: "verified" },
          { provider: "email", externalId: email, source: "sync", confidence: "verified" },
        ],
      })
    ).personId;

  const githubIdentity = async (githubId: number) =>
    (
      await db
        .select()
        .from(identities)
        .where(and(eq(identities.provider, "github"), eq(identities.externalId, String(githubId))))
    )[0];

  const sync = async () => {
    const res = await admin("POST", `/admin/tenants/${tenantId}/github/sync`);
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  const commits = (author: FakeUser | null, email: string, n: number): FakeCommit[] =>
    Array.from({ length: n }, () => ({ author, email }));

  it("links members through verified domain emails (Enterprise Cloud)", async () => {
    const alicePerson = await slackPerson("alice", "alice@acme.com");
    github.verifiedDomainEmails = { "Alice-Personal": ["Alice@acme.com"] };

    const report = await sync();

    expect(await githubIdentity(101)).toMatchObject({
      personId: alicePerson,
      handle: "alice-personal",
      source: "verified_domain",
      confidence: "verified",
    });
    expect(report).toMatchObject({
      members: 3,
      matched: 1,
      unmatched: ["bobby", "carol"],
      verifiedDomainEmails: true,
      linkedBySource: { verified_domain: 1 },
    });
  });

  it("degrades gracefully without verified domain emails", async () => {
    await slackPerson("alice", "alice@acme.com");
    const report = await sync();
    expect(report).toMatchObject({ verifiedDomainEmails: false, matched: 0 });
  });

  it("links commit authors: high with enough unambiguous commits, suggested otherwise", async () => {
    const alicePerson = await slackPerson("alice", "alice@acme.com");
    const bobPerson = await slackPerson("bob", "bob@acme.com");
    github.commits.set(`${ORG}/web`, [
      ...commits(alice, "alice@acme.com", 3),
      ...commits(bob, "bob@acme.com", 1),
      ...commits(null, "carol@acme.com", 5), // not attributed to any account by GitHub
      ...commits(carol, "carol@gmail.com", 5), // not a known work email
    ]);
    github.commits.set(`${ORG}/empty`, []);

    const report = await sync();

    expect(await githubIdentity(101)).toMatchObject({ personId: alicePerson, confidence: "high" });
    expect(await githubIdentity(102)).toMatchObject({
      personId: bobPerson,
      confidence: "suggested",
    });
    expect(await githubIdentity(103)).toBeUndefined();
    expect(report).toMatchObject({ matched: 1, suggested: 1, unmatched: ["bobby", "carol"] });
  });

  it("skips a repository it cannot read instead of failing the whole sync", async () => {
    const alicePerson = await slackPerson("alice", "alice@acme.com");
    github.commits.set(`${ORG}/blocked`, []);
    github.commitErrors.set(`${ORG}/blocked`, 403);
    github.commits.set(`${ORG}/web`, commits(alice, "alice@acme.com", 3));

    await sync();

    expect(await githubIdentity(101)).toMatchObject({ personId: alicePerson, confidence: "high" });
  });

  it("keeps GitHub handles in step with renamed logins", async () => {
    const person = await slackPerson("alice", "alice@acme.com");
    await people.attachAccount(tenantId, person, {
      provider: "github",
      externalId: "101",
      handle: "old-alice",
      source: "oauth",
      confidence: "verified",
    });

    await sync();

    expect(await githubIdentity(101)).toMatchObject({ handle: "alice-personal" });
  });

  it("does not link commit authors who are no longer org members", async () => {
    await slackPerson("alice", "alice@acme.com");
    github.members = [bob, carol]; // alice left; her commits are still in the history
    github.commits.set(`${ORG}/web`, commits(alice, "alice@acme.com", 3));

    await sync();

    expect(await githubIdentity(101)).toBeUndefined();
  });

  it("lets stronger evidence move an account and keeps weaker evidence from doing so", async () => {
    const alicePerson = await slackPerson("alice", "alice@acme.com");
    const otherPerson = await slackPerson("other", "other@acme.com");
    // A wrong guess: alice's GitHub account suggested for "other".
    await people.attachAccount(tenantId, otherPerson, {
      provider: "github",
      externalId: "101",
      handle: "alice-personal",
      source: "commit_heuristic",
      confidence: "suggested",
    });
    github.verifiedDomainEmails = { "Alice-Personal": ["alice@acme.com"] };

    await sync();
    expect(await githubIdentity(101)).toMatchObject({
      personId: alicePerson,
      confidence: "verified",
    });

    // Weaker evidence pointing back to "other" does not move it again.
    github.verifiedDomainEmails = undefined;
    github.commits.set(`${ORG}/web`, commits(alice, "other@acme.com", 10));
    const report = await sync();
    expect(await githubIdentity(101)).toMatchObject({ personId: alicePerson });
    expect(report.conflicts).toBe(1);
  });
});
