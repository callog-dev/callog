import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import { identities, type Confidence, type IdentitySource, USABLE_CONFIDENCE } from "../db/schema";
import { GithubAppService, type InstallationOctokit } from "../github/github-app.service";
import { TenantsService } from "../tenants/tenants.service";
import { matchCommitAuthors, type CommitSample } from "./commit-heuristic";
import { PeopleService, type AttachOutcome } from "./people.service";

/** How far back and how deep the commit heuristic looks per repository. */
const COMMITS_SINCE_DAYS = 90;
const MAX_COMMIT_PAGES_PER_REPO = 5;
const PAGE = 100;

export interface GithubSyncReport {
  members: number;
  /** Members linked to a person with `verified` or `high` confidence (usable for mentions). */
  matched: number;
  unmatched: string[];
  /** Links waiting for admin confirmation. */
  suggested: number;
  linkedBySource: Partial<Record<IdentitySource, number>>;
  conflicts: number;
  /** `false` when the org has no verified-domain emails (needs GitHub Enterprise Cloud). */
  verifiedDomainEmails: boolean;
}

interface Member {
  login: string;
  id: number;
}

const VERIFIED_EMAILS_QUERY = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      membersWithRole(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { login databaseId organizationVerifiedDomainEmails(login: $org) }
      }
    }
  }`;

interface VerifiedEmailsPage {
  organization: {
    membersWithRole: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { login: string; databaseId: number; organizationVerifiedDomainEmails: string[] }[];
    };
  };
}

/**
 * Links GitHub accounts of org members to people anchored by work email:
 * verified domain emails, then the commit heuristic. Never creates persons from GitHub data
 * (people come from Slack; manual links are made in /manage).
 */
@Injectable()
export class GithubIdentitySync {
  private readonly logger = new Logger(GithubIdentitySync.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly githubApp: GithubAppService,
    private readonly tenants: TenantsService,
    private readonly people: PeopleService,
  ) {}

  async sync(tenantId: string): Promise<GithubSyncReport | undefined> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant?.githubInstallationId || tenant.status !== "active") return undefined;
    const org = tenant.githubOrgLogin;
    const octokit = await this.githubApp.installationOctokit(tenant.githubInstallationId);

    const members = await this.listMembers(octokit, org);
    await this.refreshHandles(tenantId, members);
    const report: GithubSyncReport = {
      members: members.length,
      matched: 0,
      unmatched: [],
      suggested: 0,
      linkedBySource: {},
      conflicts: 0,
      verifiedDomainEmails: false,
    };
    const record = (source: IdentitySource, outcome: AttachOutcome) => {
      if (outcome.kind === "added" || outcome.kind === "moved") {
        report.linkedBySource[source] = (report.linkedBySource[source] ?? 0) + 1;
      }
      if (outcome.kind === "conflict") report.conflicts++;
    };
    const attachGithub = async (
      personId: string,
      user: Member,
      source: IdentitySource,
      confidence: Confidence,
    ) =>
      record(
        source,
        await this.people.attachAccount(tenantId, personId, {
          provider: "github",
          externalId: String(user.id),
          handle: user.login.toLowerCase(),
          source,
          confidence,
        }),
      );

    const personByEmail = await this.workEmails(tenantId);

    // 1. Verified domain emails (GitHub Enterprise Cloud with a verified domain).
    for (const { login, databaseId, emails } of await this.verifiedDomainEmails(octokit, org)) {
      for (const email of emails) {
        report.verifiedDomainEmails = true;
        const personId = personByEmail.get(email.toLowerCase());
        if (personId)
          await attachGithub(personId, { login, id: databaseId }, "verified_domain", "verified");
      }
    }

    // 3. Commit heuristic. History outlives membership: a member removed from the org
    // (and unlinked) must not be linked back by their old commits.
    const memberIds = new Set(members.map((m) => m.id));
    const samples = await this.commitSamples(octokit);
    for (const match of matchCommitAuthors(samples, new Set(personByEmail.keys()))) {
      if (!memberIds.has(match.githubId)) continue;
      const personId = personByEmail.get(match.email)!;
      await attachGithub(
        personId,
        { login: match.login, id: match.githubId },
        "commit_heuristic",
        match.confidence,
      );
    }

    // Coverage.
    const linked = await this.db
      .select({ externalId: identities.externalId, confidence: identities.confidence })
      .from(identities)
      .where(and(eq(identities.tenantId, tenantId), eq(identities.provider, "github")));
    const usable = new Set(
      linked.filter((l) => l.confidence !== "suggested").map((l) => l.externalId),
    );
    report.suggested = linked.filter((l) => l.confidence === "suggested").length;
    for (const member of members) {
      if (usable.has(String(member.id))) report.matched++;
      else report.unmatched.push(member.login);
    }

    this.logger.log(`GitHub identity sync for tenant ${tenantId}: ${JSON.stringify(report)}`);
    return report;
  }

  /**
   * Logins change on rename and can then be taken by someone else: keep the stored handles
   * (what `github:login` refs and `admins` match) in step with the members' current logins.
   */
  private async refreshHandles(tenantId: string, members: Member[]): Promise<void> {
    if (members.length === 0) return;
    // One statement for the whole org: (id, login) pairs joined against stored identities.
    const pairs = members.map((m) => ({
      external_id: String(m.id),
      handle: m.login.toLowerCase(),
    }));
    await this.db.execute(sql`
      update identities set handle = m.handle
      from json_to_recordset(${JSON.stringify(pairs)}::json) as m(external_id text, handle text)
      where identities.tenant_id = ${tenantId}
        and identities.provider = 'github'
        and identities.external_id = m.external_id
        and identities.handle is distinct from m.handle`);
  }

  /** Work emails (verified/high) → person. */
  private async workEmails(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ email: identities.externalId, personId: identities.personId })
      .from(identities)
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.provider, "email"),
          inArray(identities.confidence, [...USABLE_CONFIDENCE]),
        ),
      );
    return new Map(rows.map((r) => [r.email, r.personId]));
  }

  private async listMembers(octokit: InstallationOctokit, org: string): Promise<Member[]> {
    const members: Member[] = [];
    for (let page = 1; ; page++) {
      const { data } = await octokit.request("GET /orgs/{org}/members", {
        org,
        per_page: PAGE,
        page,
      });
      members.push(...data.map((m) => ({ login: m.login, id: Number(m.id) })));
      if (data.length < PAGE) return members;
    }
  }

  private async verifiedDomainEmails(octokit: InstallationOctokit, org: string) {
    const result: { login: string; databaseId: number; emails: string[] }[] = [];
    try {
      let cursor: string | null = null;
      do {
        const page: VerifiedEmailsPage = await octokit.graphql(VERIFIED_EMAILS_QUERY, {
          org,
          cursor,
        });
        const { nodes, pageInfo } = page.organization.membersWithRole;
        for (const n of nodes) {
          result.push({
            login: n.login,
            databaseId: n.databaseId,
            emails: n.organizationVerifiedDomainEmails,
          });
        }
        cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      } while (cursor);
    } catch (err) {
      this.logger.warn(`Verified domain emails unavailable for ${org}: ${String(err)}`);
    }
    return result;
  }

  private async commitSamples(octokit: InstallationOctokit): Promise<CommitSample[]> {
    const since = new Date(Date.now() - COMMITS_SINCE_DAYS * 86_400_000).toISOString();
    const samples: CommitSample[] = [];
    for (const repo of await this.listRepos(octokit)) {
      for (let page = 1; page <= MAX_COMMIT_PAGES_PER_REPO; page++) {
        const data = await octokit
          .request("GET /repos/{owner}/{repo}/commits", {
            owner: repo.owner,
            repo: repo.name,
            since,
            per_page: PAGE,
            page,
          })
          .then(
            (res) => res.data,
            (err: unknown) => {
              const status = (err as { status?: number }).status;
              if (status === 409) return []; // empty repository
              // Deleted, blocked or otherwise unreadable repos must not abort the sync;
              // other errors (5xx, network) fail the job so it is retried.
              if (status === 403 || status === 404 || status === 451) {
                this.logger.warn(`Skipping ${repo.owner}/${repo.name} commits: HTTP ${status}`);
                return [];
              }
              throw err;
            },
          );
        for (const c of data) {
          // `author` is set only when GitHub attributed the commit email to an account.
          const author = c.author && "login" in c.author ? c.author : undefined;
          if (author && c.commit.author?.email) {
            samples.push({
              login: author.login,
              githubId: Number(author.id),
              email: c.commit.author.email,
            });
          }
        }
        if (data.length < PAGE) break;
      }
    }
    return samples;
  }

  private async listRepos(octokit: InstallationOctokit) {
    const repos: { owner: string; name: string }[] = [];
    for (let page = 1; ; page++) {
      const { data } = await octokit.request("GET /installation/repositories", {
        per_page: PAGE,
        page,
      });
      repos.push(...data.repositories.map((r) => ({ owner: r.owner.login, name: r.name })));
      if (data.repositories.length < PAGE) return repos;
    }
  }
}
