import { Inject, Injectable, Logger } from "@nestjs/common";
import { ownValue, parseRef, type Config, type Ref } from "@callog/config-schema";
import { escapeTelegram, type MentionResolver } from "@callog/templates";
import { and, eq, inArray, sql } from "drizzle-orm";
import { setBounded } from "../common/bounded-map";
import { DB, type Db } from "../db/db";
import {
  identities,
  persons,
  unmappedRecipients,
  type Provider,
  USABLE_CONFIDENCE,
} from "../db/schema";
import { GithubAppService } from "../github/github-app.service";
import { normalizeExternalId } from "../identity/people.service";
import { MetricsService } from "../metrics/metrics.service";
import { SlackSender } from "../slack/slack-sender";
import { TenantsService } from "../tenants/tenants.service";

/** Channels a message can be rendered for. */
export type TargetProvider = Extract<Provider, "slack" | "telegram">;

/** `person:` recipients carry a Person id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Team expansions via provider APIs are cached briefly (one burst of deliveries). */
const TEAM_CACHE_MS = 60_000;
const MAX_TEAM_CACHE = 1_000;

export interface ResolvedPerson {
  personId: string;
  displayName: string;
  /** The person's account at the target provider, if linked. */
  target?: { externalId: string; handle: string | null };
}

export interface ResolvedRef {
  ref: Ref;
  persons: ResolvedPerson[];
  /** The ref belongs to a known person, even an inactive one (who is not in `persons`). */
  known?: boolean;
  /** Slack user group id when a team maps to one (mentioned as the group itself). */
  slackUsergroupId?: string;
}

export interface Resolution {
  refs: ResolvedRef[];
  /** Synchronous mention markup for templates. */
  mention: MentionResolver;
  /** Refs that produced no mentionable account at the target provider. */
  unmapped: Ref[];
  /** For unmapped teams: why (unknown team, no `members_from`, nobody linked). */
  reasons: Map<Ref, string>;
}

export interface TeamDescription {
  reason?: string;
  members: {
    ref: Ref;
    provider: "github" | "slack";
    handle: string;
    person: { id: string; name: string; status: "active" | "inactive" } | null;
  }[];
}

interface TeamExpansion {
  members: Ref[];
  slackUsergroupId?: string;
  /** Set when the team cannot have members at all. */
  reason?: string;
}

type PersonRefKind = "github" | "email" | "slack" | "telegram" | "person";

/**
 * Turns recipient refs (`github:octocat`, `team:frontend`, …) into people and their
 * accounts at the target provider. Only active people and
 * verified/high identities are used; everything else falls back to plain text.
 */
@Injectable()
export class RecipientResolver {
  private readonly logger = new Logger(RecipientResolver.name);
  private readonly teamCache = new Map<string, { at: number; value: unknown }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tenants: TenantsService,
    private readonly githubApp: GithubAppService,
    private readonly slack: SlackSender,
    private readonly metrics: MetricsService,
  ) {}

  async resolve(
    tenantId: string,
    config: Config,
    refs: Ref[],
    target: TargetProvider,
  ): Promise<Resolution> {
    // 1. Expand teams into member refs.
    const expanded = new Map<Ref, TeamExpansion>();
    for (const ref of refs) {
      const { kind, value } = parseRef(ref);
      if (kind === "team") expanded.set(ref, await this.expandTeam(tenantId, config, value));
    }
    const personRefs = new Set<Ref>();
    for (const ref of refs) {
      if (parseRef(ref).kind !== "team") personRefs.add(ref);
    }
    for (const { members } of expanded.values()) members.forEach((m) => personRefs.add(m));

    // 2. Refs → person ids.
    const personIdByRef = await this.lookupPersons(tenantId, [...personRefs]);

    // 3. Active persons and their target accounts.
    const personIds = [...new Set(personIdByRef.values())];
    const people = personIds.length
      ? await this.db
          .select({ id: persons.id, displayName: persons.displayName })
          .from(persons)
          .where(
            and(
              eq(persons.tenantId, tenantId),
              inArray(persons.id, personIds),
              eq(persons.status, "active"),
            ),
          )
      : [];
    const targets = personIds.length
      ? await this.db
          .select({
            personId: identities.personId,
            externalId: identities.externalId,
            handle: identities.handle,
          })
          .from(identities)
          .where(
            and(
              eq(identities.tenantId, tenantId),
              inArray(identities.personId, personIds),
              eq(identities.provider, target),
              inArray(identities.confidence, [...USABLE_CONFIDENCE]),
            ),
          )
      : [];
    const personById = new Map<string, ResolvedPerson>(
      people.map((p) => {
        const t = targets.find((x) => x.personId === p.id);
        return [
          p.id,
          {
            personId: p.id,
            displayName: p.displayName,
            target: t && { externalId: t.externalId, handle: t.handle },
          },
        ];
      }),
    );
    const personsFor = (ref: Ref): ResolvedPerson[] => {
      const person = personById.get(personIdByRef.get(ref) ?? "");
      return person ? [person] : [];
    };

    // 4. Assemble.
    const resolved: ResolvedRef[] = refs.map((ref) => {
      const team = expanded.get(ref);
      if (!team) return { ref, persons: personsFor(ref), known: personIdByRef.has(ref) };
      const members = new Map<string, ResolvedPerson>();
      for (const m of team.members) for (const p of personsFor(m)) members.set(p.personId, p);
      return { ref, persons: [...members.values()], slackUsergroupId: team.slackUsergroupId };
    });

    const markup = new Map<Ref, string[]>();
    for (const r of resolved) {
      const m = mentionMarkup(r, target);
      if (m !== undefined) markup.set(r.ref, m);
    }
    const unmapped = refs.filter((ref) => !markup.has(ref));
    const reasons = new Map<Ref, string>();
    for (const ref of unmapped) {
      const team = expanded.get(ref);
      if (team) reasons.set(ref, team.reason ?? `nobody in the team is linked at ${target}`);
    }
    return {
      refs: resolved,
      mention: (ref) => markup.get(ref),
      unmapped,
      reasons,
    };
  }

  /** Counts unmapped recipients for the admin report. */
  async recordUnmapped(
    tenantId: string,
    refs: Ref[],
    provider: TargetProvider,
    routeId: string,
    reasons: Map<Ref, string> = new Map(),
  ): Promise<void> {
    this.metrics.unmappedRecipients.inc({ provider }, new Set(refs).size);
    for (const ref of new Set(refs)) {
      const reason = reasons.get(ref) ?? null;
      await this.db
        .insert(unmappedRecipients)
        .values({ tenantId, ref, provider, lastRouteId: routeId, reason })
        .onConflictDoUpdate({
          target: [
            unmappedRecipients.tenantId,
            unmappedRecipients.ref,
            unmappedRecipients.provider,
          ],
          set: {
            occurrences: sql`${unmappedRecipients.occurrences} + 1`,
            lastRouteId: routeId,
            reason,
            lastSeenAt: new Date(),
          },
        });
    }
  }

  /**
   * Who a team's `members_from` points at and whether each account is linked to a person,
   * for the Teams screen in /manage. Inactive people are reported, not hidden.
   */
  async describeTeam(tenantId: string, config: Config, slug: string): Promise<TeamDescription> {
    const { members, reason } = await this.expandTeam(tenantId, config, slug);
    const personIdByRef = await this.lookupPersons(tenantId, members);
    const ids = [...new Set(personIdByRef.values())];
    const people = ids.length
      ? await this.db
          .select({ id: persons.id, name: persons.displayName, status: persons.status })
          .from(persons)
          .where(and(eq(persons.tenantId, tenantId), inArray(persons.id, ids)))
      : [];
    return {
      reason,
      members: members.map((ref) => {
        const { kind, value } = parseRef(ref);
        const person = people.find((p) => p.id === personIdByRef.get(ref));
        return { ref, provider: kind as "github" | "slack", handle: value, person: person ?? null };
      }),
    };
  }

  private async lookupPersons(tenantId: string, refs: Ref[]): Promise<Map<Ref, string>> {
    const byKind = new Map<PersonRefKind, Ref[]>();
    for (const ref of refs) {
      const kind = parseRef(ref).kind as PersonRefKind;
      byKind.set(kind, [...(byKind.get(kind) ?? []), ref]);
    }
    const result = new Map<Ref, string>();

    // Person ids come from producers: only well-formed ones (the tenant check is below).
    for (const ref of byKind.get("person") ?? []) {
      const id = parseRef(ref).value;
      if (UUID.test(id)) result.set(ref, id);
    }

    // GitHub refs use logins, stored as handles (external_id is the numeric id).
    const github = byKind.get("github") ?? [];
    if (github.length) {
      const rows = await this.usableIdentities(
        tenantId,
        "github",
        identities.handle,
        github.map((r) => parseRef(r).value.toLowerCase()),
      );
      for (const ref of github) {
        const row = rows.find((r) => r.key === parseRef(ref).value.toLowerCase());
        if (row) result.set(ref, row.personId);
      }
    }
    for (const provider of ["email", "slack", "telegram"] as const) {
      const list = byKind.get(provider) ?? [];
      if (!list.length) continue;
      const keys = list.map((r) => normalizeExternalId(provider, parseRef(r).value));
      const rows = await this.usableIdentities(tenantId, provider, identities.externalId, keys);
      list.forEach((ref, i) => {
        const row = rows.find((r) => r.key === keys[i]);
        if (row) result.set(ref, row.personId);
      });
    }
    return result;
  }

  private async usableIdentities(
    tenantId: string,
    provider: Provider,
    column: typeof identities.handle | typeof identities.externalId,
    keys: string[],
  ) {
    const rows = await this.db
      .select({ key: column, personId: identities.personId })
      .from(identities)
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.provider, provider),
          inArray(column, keys),
          inArray(identities.confidence, [...USABLE_CONFIDENCE]),
        ),
      );
    return rows as { key: string; personId: string }[];
  }

  /** A team's people come only from `members_from`. */
  private async expandTeam(tenantId: string, config: Config, slug: string): Promise<TeamExpansion> {
    const team = ownValue(config.teams, slug);
    if (!team) return { members: [], reason: `unknown team "${slug}" (not in teams.yaml)` };
    if (!team.members_from) {
      return { members: [], reason: `team "${slug}" has no members_from, it is only an address` };
    }
    const members: Ref[] = [];
    let slackUsergroupId: string | undefined;

    const githubTeam = team.members_from?.github_team;
    if (githubTeam) {
      const logins = await this.cached(`${tenantId}:gh:${githubTeam}`, () =>
        this.githubTeamLogins(tenantId, githubTeam),
      );
      members.push(...logins.map((login) => `github:${login}` as Ref));
    }
    const usergroupHandle = team.members_from?.slack_usergroup;
    if (usergroupHandle) {
      const group = await this.cached(`${tenantId}:sg:${usergroupHandle}`, () =>
        this.slack.usergroup(tenantId, usergroupHandle).catch((err: unknown) => {
          this.logger.warn(`Slack user group "${usergroupHandle}" unavailable: ${String(err)}`);
          return undefined;
        }),
      );
      if (group) {
        slackUsergroupId = group.id;
        members.push(...group.users.map((id) => `slack:${id}` as Ref));
      }
    }
    return { members, slackUsergroupId };
  }

  private async githubTeamLogins(tenantId: string, teamSlug: string): Promise<string[]> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant?.githubInstallationId) return [];
    const octokit = await this.githubApp.installationOctokit(tenant.githubInstallationId);
    try {
      const logins: string[] = [];
      for (let page = 1; ; page++) {
        const { data } = await octokit.request("GET /orgs/{org}/teams/{team_slug}/members", {
          org: tenant.githubOrgLogin,
          team_slug: teamSlug,
          per_page: 100,
          page,
        });
        logins.push(...data.map((m) => m.login));
        if (data.length < 100) return logins;
      }
    } catch (err) {
      this.logger.warn(`GitHub team "${teamSlug}" unavailable: ${String(err)}`);
      return [];
    }
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.teamCache.get(key);
    if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.value as T;
    const value = await load();
    setBounded(this.teamCache, key, { at: Date.now(), value }, MAX_TEAM_CACHE);
    return value;
  }
}

/** Provider markup for one resolved ref, or undefined to fall back to plain text. */
function mentionMarkup(resolved: ResolvedRef, target: TargetProvider): string[] | undefined {
  const { kind, value } = parseRef(resolved.ref);
  if (target === "slack") {
    if (resolved.slackUsergroupId) return [`<!subteam^${resolved.slackUsergroupId}>`];
    // An explicit Slack id is mentionable even if the person is not synced yet.
    if (kind === "slack" && !resolved.known) return [`<@${value}>`];
    const ids = resolved.persons.flatMap((p) => (p.target ? [`<@${p.target.externalId}>`] : []));
    return ids.length ? ids : undefined;
  }
  // Telegram: @username when known, otherwise a text mention by user id.
  if (kind === "telegram" && !resolved.known) {
    return [
      /^\d+$/.test(value)
        ? `<a href="tg://user?id=${value}">${escapeTelegram(value)}</a>`
        : `@${escapeTelegram(value.replace(/^@/, ""))}`,
    ];
  }
  const links = resolved.persons.flatMap((p) => {
    if (!p.target) return [];
    return [
      p.target.handle
        ? `@${escapeTelegram(p.target.handle)}`
        : `<a href="tg://user?id=${p.target.externalId}">${escapeTelegram(p.displayName)}</a>`,
    ];
  });
  return links.length ? links : undefined;
}
