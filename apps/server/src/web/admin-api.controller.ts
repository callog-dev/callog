import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ownValue, parseRef, type ConfigIssue, type Ref } from "@callog/config-schema";
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { parseBody } from "../admin/parse-body";
import { DB, type Db } from "../db/db";
import {
  configVersions,
  deliveries,
  identities,
  notifications,
  persons,
  unmappedRecipients,
  USABLE_CONFIDENCE,
} from "../db/schema";
import { GithubAppService } from "../github/github-app.service";
import { PeopleService } from "../identity/people.service";
import { AuditService } from "../audit/audit.service";
import { LifecycleJobs } from "../lifecycle/lifecycle.jobs";
import { RetentionService } from "../lifecycle/retention.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PreferencesService } from "../identity/preferences.service";
import { TenantAdminsService } from "../identity/tenant-admins.service";
import { apiKeyNameSchema, ApiKeysService } from "../producers/api-keys.service";
import {
  asBadRequest as asSlackBadRequest,
  slackConnectBody,
} from "../slack/admin-slack.controller";
import { SlackSender } from "../slack/slack-sender";
import { SlackTokenRejectedError } from "../slack/slack-api";
import { SlackConnectionsService } from "../slack/slack-connections.service";
import { SlackEvents } from "../slack/slack-events";
import {
  asBadRequest as asTelegramBadRequest,
  telegramConnectBody,
} from "../telegram/admin-telegram.controller";
import { TelegramSender } from "../telegram/telegram-sender";
import { TelegramApiError } from "../telegram/telegram-api";
import { TelegramChatsService } from "../telegram/telegram-chats.service";
import { TelegramConnectionsService } from "../telegram/telegram-connections.service";
import { RecipientResolver, refsNaming } from "../routing/recipient-resolver";
import { ConfigLoader } from "../tenant-config/config-loader";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { configRepoOf, TenantsService } from "../tenants/tenants.service";
import { AdminCheck } from "./admin-check";
import { AdminSessionGuard } from "./admin-session.guard";
import type { SessionRequest } from "./session.guard";

const PAGE = 50;
/** The hourly sync is late when it has not finished for this long. */
const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

type AttentionItem =
  | { kind: "config_rejected"; versionId: string; errors: number }
  | { kind: "no_config" | "slack_missing" }
  | { kind: "failed" | "partially_failed" | "unmapped" | "suggested"; count: number }
  | { kind: "sync_stale"; lastSyncedAt: string | null };
const MAINTENANCE = { sync: "maintenance.sync", retention: "maintenance.retention" } as const;
const TEST_TEXT = "Callog is connected: this is a test message from the admin UI.";
const slackTestBody = z.object({ channel: z.string().trim().min(1) });
const telegramTestBody = z.object({ chatId: z.string().trim().min(1) });
const DAY_MS = 86_400_000;
const PERIOD_DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;

const linkBody = z.object({
  personId: z.uuid(),
  /** `github:login`, `email:…`, `slack:U…`, `telegram:<user id>` */
  ref: z
    .string()
    .regex(/^(github|email|slack|telegram):\S+$/, "github:…, email:…, slack:… or telegram:…"),
});
const notificationsQuery = z.object({
  status: z.enum(notifications.status.enumValues).optional(),
  route: z.string().optional(),
  /** A repository (GitHub Actions) or an API key name. */
  source: z.string().optional(),
  period: z.enum(["24h", "7d", "30d"]).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});
const peopleQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
});
const newerQuery = notificationsQuery.omit({ before: true }).extend({ after: z.uuid() });
const versionsQuery = z.object({ before: z.iso.datetime({ offset: true }).optional() });
const apiKeyBody = z.object({ name: apiKeyNameSchema });
const adminBody = z.object({ personId: z.uuid() });

/** The problems stored with a config version (`errors` holds both lists). */
function issuesOf(version: { errors: unknown }) {
  const issues = (version.errors ?? {}) as { errors?: ConfigIssue[]; warnings?: ConfigIssue[] };
  return { errors: issues.errors ?? [], warnings: issues.warnings ?? [] };
}

function notificationFilter(
  tenantId: string,
  { status, route, source, period }: z.infer<typeof notificationsQuery>,
) {
  return and(
    eq(notifications.tenantId, tenantId),
    status ? eq(notifications.status, status) : undefined,
    route ? eq(notifications.routeId, route) : undefined,
    source
      ? or(
          sql`${notifications.source}->>'repository' = ${source}`,
          sql`${notifications.source}->>'apiKeyName' = ${source}`,
        )
      : undefined,
    period
      ? gte(notifications.createdAt, new Date(Date.now() - PERIOD_DAYS[period] * DAY_MS))
      : undefined,
  );
}

function identityView(i: typeof identities.$inferSelect) {
  return {
    id: i.id,
    provider: i.provider,
    externalId: i.externalId,
    handle: i.handle,
    source: i.source,
    confidence: i.confidence,
  };
}

/** Admin section of the web UI. Replaces the ADMIN_TOKEN endpoints for people. */
@Controller("api/admin")
@UseGuards(AdminSessionGuard)
export class AdminApiController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tenants: TenantsService,
    private readonly configs: TenantConfigService,
    private readonly loader: ConfigLoader,
    private readonly people: PeopleService,
    private readonly apiKeys: ApiKeysService,
    private readonly slack: SlackConnectionsService,
    private readonly slackEvents: SlackEvents,
    private readonly telegram: TelegramConnectionsService,
    private readonly telegramChats: TelegramChatsService,
    private readonly githubApp: GithubAppService,
    private readonly admins: TenantAdminsService,
    private readonly adminCheck: AdminCheck,
    private readonly resolver: RecipientResolver,
    private readonly pipeline: NotificationsService,
    private readonly slackSender: SlackSender,
    private readonly preferences: PreferencesService,
    private readonly audit: AuditService,
    private readonly lifecycle: LifecycleJobs,
    private readonly retention: RetentionService,
    private readonly telegramSender: TelegramSender,
  ) {}

  // ---- Teams ----

  /** Teams of the active config with their `members_from` resolved to people. */
  @Get("teams")
  async teams(@Req() req: SessionRequest) {
    const { tenantId } = req.session!;
    const config = (await this.configs.getActive(tenantId))?.config;
    if (!config) return [];
    const out = [];
    for (const [slug, team] of Object.entries(config.teams)) {
      const { members, reason } = await this.resolver.describeTeam(tenantId, config, slug);
      out.push({
        slug,
        slackChannel: team.slack_channel ?? null,
        telegramChat: team.telegram_chat ?? null,
        membersFrom: team.members_from
          ? {
              githubTeam: team.members_from.github_team ?? null,
              slackUsergroup: team.members_from.slack_usergroup ?? null,
            }
          : null,
        reason: reason ?? null,
        members,
        total: members.length,
        linked: members.filter((m) => m.person !== null).length,
      });
    }
    return out;
  }

  // ---- Admins ----

  @Get("admins")
  async adminsList(@Req() req: SessionRequest) {
    const { tenantId } = req.session!;
    const [owners, admins, audit] = await Promise.all([
      this.adminCheck.listOrgOwners(tenantId),
      this.admins.list(tenantId),
      this.admins.audit(tenantId),
    ]);
    return { owners, admins, audit };
  }

  @Post("admins")
  async grantAdmin(@Req() req: SessionRequest, @Body() body: unknown) {
    const { tenantId } = req.session!;
    const { personId } = parseBody(adminBody, body);
    const [person] = await this.db
      .select({ status: persons.status })
      .from(persons)
      .where(and(eq(persons.tenantId, tenantId), eq(persons.id, personId)));
    if (!person) throw new NotFoundException("No such person");
    if (person.status !== "active") throw new BadRequestException("The person is inactive");
    return { ok: true, changed: await this.admins.grant(tenantId, personId, req.session!) };
  }

  @Delete("admins/:personId")
  @HttpCode(204)
  async revokeAdmin(
    @Req() req: SessionRequest,
    @Param("personId", ParseUUIDPipe) personId: string,
  ): Promise<void> {
    const { tenantId } = req.session!;
    if (await this.adminCheck.isOrgOwner(tenantId, personId)) {
      throw new BadRequestException(
        "GitHub org owners are always admins; change the role on GitHub",
      );
    }
    if (!(await this.admins.revoke(tenantId, personId, req.session!)))
      throw new NotFoundException();
  }

  // ---- Deliveries ----

  /**
   * Latest notifications with their deliveries, newest first; `before` (the previous page's
   * `nextBefore`) pages backwards.
   */
  @Get("notifications")
  async notifications(@Req() req: SessionRequest, @Query() query: unknown) {
    const { tenantId } = req.session!;
    const filters = parseBody(notificationsQuery, query);
    const rows = await this.db
      .select({
        id: notifications.id,
        route: notifications.routeId,
        status: notifications.status,
        source: notifications.source,
        threadKey: notifications.threadKey,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(
          notificationFilter(tenantId, filters),
          filters.before ? lt(notifications.createdAt, new Date(filters.before)) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(PAGE);
    const ds = rows.length
      ? await this.db
          .select({
            notificationId: deliveries.notificationId,
            provider: deliveries.provider,
            destination: deliveries.destination,
            status: deliveries.status,
          })
          .from(deliveries)
          .where(
            inArray(
              deliveries.notificationId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    return {
      items: rows.map((r) => ({ ...r, deliveries: ds.filter((d) => d.notificationId === r.id) })),
      nextBefore: rows.length === PAGE ? rows.at(-1)!.createdAt.toISOString() : null,
    };
  }

  /** How many notifications matching the filters came after `after` (an id), for "N new". */
  @Get("notifications/count")
  async notificationCount(@Req() req: SessionRequest, @Query() query: unknown) {
    const { after, ...filters } = parseBody(newerQuery, query);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          notificationFilter(req.session!.tenantId, filters),
          // Compared in SQL: JS dates drop the microseconds of created_at.
          sql`${notifications.createdAt} > (select created_at from notifications where id = ${after})`,
        ),
      );
    return { count: row!.count };
  }

  /** Full notification incl. payload — admins only. */
  @Get("notifications/:id")
  async notification(@Req() req: SessionRequest, @Param("id", ParseUUIDPipe) id: string) {
    const [n] = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, req.session!.tenantId), eq(notifications.id, id)));
    if (!n) throw new NotFoundException();
    const ds = await this.db.select().from(deliveries).where(eq(deliveries.notificationId, id));
    return {
      id: n.id,
      route: n.routeId,
      status: n.status,
      source: n.source,
      data: n.data,
      recipients: n.recipients,
      threadKey: n.threadKey,
      update: n.update,
      createdAt: n.createdAt,
      deliveries: ds.map((d) => ({
        provider: d.provider,
        destination: d.destination,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        sentAt: d.sentAt,
      })),
    };
  }

  /** Sends the failed deliveries of a failed or partially failed notification again. */
  @Post("notifications/:id/retry")
  @HttpCode(202)
  async retry(@Req() req: SessionRequest, @Param("id", ParseUUIDPipe) id: string) {
    await this.pipeline.retry(req.session!.tenantId, id, req.session!);
    return { status: "accepted" };
  }

  // ---- People ----

  /**
   * One page of people by name. `q` matches the name or any linked account (login, email,
   * Slack or Telegram id).
   */
  @Get("people")
  async peopleList(@Req() req: SessionRequest, @Query() query: unknown) {
    const { tenantId } = req.session!;
    const { q, status, page } = parseBody(peopleQuery, query);
    const pattern = q && `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = and(
      eq(persons.tenantId, tenantId),
      status === "all" ? undefined : eq(persons.status, status),
      pattern
        ? or(
            ilike(persons.displayName, pattern),
            sql`exists (select 1 from ${identities} i where i.person_id = ${persons.id}
              and (i.handle ilike ${pattern} or i.external_id ilike ${pattern}))`,
          )
        : undefined,
    );
    const [ps, [count]] = await Promise.all([
      this.db
        .select()
        .from(persons)
        .where(where)
        .orderBy(persons.displayName, persons.id)
        .limit(PAGE)
        .offset((page - 1) * PAGE),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(persons)
        .where(where),
    ]);
    const ids = ps.length
      ? await this.db
          .select()
          .from(identities)
          .where(
            inArray(
              identities.personId,
              ps.map((p) => p.id),
            ),
          )
      : [];
    return {
      items: ps.map((p) => ({
        id: p.id,
        name: p.displayName,
        status: p.status,
        identities: ids.filter((i) => i.personId === p.id).map(identityView),
      })),
      total: count!.total,
      pageSize: PAGE,
    };
  }

  /** Links guessed from commit history, waiting for an admin to confirm or reject them. */
  @Get("identities/suggested")
  async suggestedLinks(@Req() req: SessionRequest) {
    const rows = await this.db
      .select({ identity: identities, person: { id: persons.id, name: persons.displayName } })
      .from(identities)
      .innerJoin(persons, eq(persons.id, identities.personId))
      .where(
        and(eq(identities.tenantId, req.session!.tenantId), eq(identities.confidence, "suggested")),
      )
      .orderBy(persons.displayName, identities.createdAt);
    return rows.map((r) => ({ ...identityView(r.identity), person: r.person }));
  }

  /** Active people for pickers (link an account, grant the admin role). */
  @Get("people/options")
  peopleOptions(@Req() req: SessionRequest) {
    return this.db
      .select({ id: persons.id, name: persons.displayName })
      .from(persons)
      .where(and(eq(persons.tenantId, req.session!.tenantId), eq(persons.status, "active")))
      .orderBy(persons.displayName);
  }

  /** A person with their accounts, role, preferences and the latest notifications naming them. */
  @Get("people/:id")
  async person(@Req() req: SessionRequest, @Param("id", ParseUUIDPipe) id: string) {
    const { tenantId } = req.session!;
    const [person] = await this.db
      .select()
      .from(persons)
      .where(and(eq(persons.tenantId, tenantId), eq(persons.id, id)));
    if (!person) throw new NotFoundException();
    const accounts = await this.db.select().from(identities).where(eq(identities.personId, id));
    const refs = refsNaming(id, accounts);
    const [admin, preferences, recent] = await Promise.all([
      this.admins.has(tenantId, id),
      this.preferences.get(id),
      this.db
        .select({
          id: notifications.id,
          route: notifications.routeId,
          status: notifications.status,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            sql`exists (select 1 from unnest(${notifications.recipients}) r
              where lower(r) in (${sql.join(
                refs.map((r) => sql`${r}`),
                sql`, `,
              )}))`,
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(10),
    ]);
    return {
      id: person.id,
      name: person.displayName,
      status: person.status,
      admin,
      identities: accounts.map(identityView),
      preferences,
      recentNotifications: recent,
    };
  }

  @Get("unmapped")
  unmapped(@Req() req: SessionRequest) {
    return this.db
      .select({
        ref: unmappedRecipients.ref,
        provider: unmappedRecipients.provider,
        occurrences: unmappedRecipients.occurrences,
        lastRoute: unmappedRecipients.lastRouteId,
        reason: unmappedRecipients.reason,
        lastSeenAt: unmappedRecipients.lastSeenAt,
      })
      .from(unmappedRecipients)
      .where(eq(unmappedRecipients.tenantId, req.session!.tenantId))
      .orderBy(desc(unmappedRecipients.occurrences));
  }

  /** Approves a `suggested` link (commit heuristic) — it becomes usable for mentions. */
  @Post("identities/:id/confirm")
  async confirm(@Req() req: SessionRequest, @Param("id", ParseUUIDPipe) id: string) {
    const rows = await this.db
      .update(identities)
      .set({ confidence: "verified", source: "admin" })
      .where(and(eq(identities.tenantId, req.session!.tenantId), eq(identities.id, id)))
      .returning({ id: identities.id });
    if (rows.length === 0) throw new NotFoundException();
    return { ok: true };
  }

  @Delete("identities/:id")
  @HttpCode(204)
  async unlink(@Req() req: SessionRequest, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    const rows = await this.db
      .delete(identities)
      .where(and(eq(identities.tenantId, req.session!.tenantId), eq(identities.id, id)))
      .returning({ id: identities.id });
    if (rows.length === 0) throw new NotFoundException();
  }

  /** Links an account to a person by hand (verified, source admin); resolves GitHub logins to ids. */
  @Post("links")
  async link(@Req() req: SessionRequest, @Body() body: unknown) {
    const { tenantId } = req.session!;
    const { personId, ref } = parseBody(linkBody, body);
    const [person] = await this.db
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.tenantId, tenantId), eq(persons.id, personId)));
    if (!person) throw new NotFoundException("Person not found");

    const { kind, value } = parseRef(ref as Ref);
    let account: {
      provider: "github" | "email" | "slack" | "telegram";
      externalId: string;
      handle?: string;
    };
    if (kind === "github") {
      const user = await this.githubUser(tenantId, value);
      account = {
        provider: "github",
        externalId: String(user.id),
        handle: user.login.toLowerCase(),
      };
    } else {
      account = { provider: kind as "email" | "slack" | "telegram", externalId: value };
    }
    const outcome = await this.people.attachAccount(tenantId, personId, {
      ...account,
      source: "admin",
      confidence: "verified",
    });
    if (outcome.kind === "conflict") {
      throw new BadRequestException(
        `${ref} is already verified for another person — unlink it there first`,
      );
    }
    await this.db
      .delete(unmappedRecipients)
      .where(and(eq(unmappedRecipients.tenantId, tenantId), eq(unmappedRecipients.ref, ref)));
    return { ok: true, outcome: outcome.kind };
  }

  // ---- API keys ----

  @Get("api-keys")
  listKeys(@Req() req: SessionRequest) {
    return this.apiKeys.list(req.session!.tenantId);
  }

  @Post("api-keys")
  async createKey(@Req() req: SessionRequest, @Body() body: unknown) {
    const { name } = parseBody(apiKeyBody, body);
    const { key, info } = await this.apiKeys.create(req.session!.tenantId, name);
    return { key, ...info };
  }

  @Delete("api-keys/:name")
  @HttpCode(204)
  async revokeKey(@Req() req: SessionRequest, @Param("name") name: string): Promise<void> {
    if (!(await this.apiKeys.revoke(req.session!.tenantId, name))) throw new NotFoundException();
  }

  // ---- Config and integrations ----

  // ---- Test notification ----

  /**
   * Sends the route's first example through the normal pipeline, mentioning whoever pressed
   * the button: it proves the config, the channels and the person's links at once.
   */
  @Post("routes/:routeId/test")
  async testRoute(@Req() req: SessionRequest, @Param("routeId") routeId: string) {
    const session = req.session!;
    const route = ownValue(
      (await this.configs.getActive(session.tenantId))?.config.routes ?? {},
      routeId,
    );
    if (!route) throw new NotFoundException(`Route "${routeId}" is not in the active config`);
    const login =
      session.githubLogin ?? (await this.githubLoginOf(session.tenantId, session.personId!));
    const { notificationId } = await this.pipeline.accept(
      {
        tenantId: session.tenantId,
        source: { type: "admin_test", actor: login ? `@${login}` : "an admin" },
        label: "A test from the admin UI",
      },
      {
        route: route.id,
        data: route.examples[0]?.data ?? {},
        recipients: login ? [`github:${login}`] : [],
        update: false,
      },
    );
    return { notificationId };
  }

  // ---- Channels ----

  /** Both tokens: the bot token posts, the app-level one runs /notify over Socket Mode. */
  @Put("slack")
  async connectSlack(@Req() req: SessionRequest, @Body() body: unknown) {
    const { tenantId } = req.session!;
    const { botToken, appToken } = parseBody(slackConnectBody.required(), body);
    try {
      const connection = await this.slack.connect(tenantId, botToken, appToken);
      await this.slackEvents.requestSync(tenantId);
      return { team: connection.teamName };
    } catch (err) {
      if (err instanceof SlackTokenRejectedError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Put("telegram")
  async connectTelegram(@Req() req: SessionRequest, @Body() body: unknown) {
    const { tenantId } = req.session!;
    const { botToken } = parseBody(telegramConnectBody, body);
    try {
      return { bot: (await this.telegram.connect(tenantId, botToken)).botUsername };
    } catch (err) {
      if (err instanceof TelegramApiError)
        throw new BadRequestException(`Telegram rejected the token: ${err.description}`);
      throw err;
    }
  }

  @Delete("slack")
  @HttpCode(204)
  async disconnectSlack(@Req() req: SessionRequest) {
    if (!(await this.slack.disconnect(req.session!.tenantId))) throw new NotFoundException();
  }

  /** People sync runs in the background; `lastSyncedAt` in `/status` moves when it is done. */
  @Post("slack/sync")
  @HttpCode(202)
  async syncSlack(@Req() req: SessionRequest) {
    const { tenantId } = req.session!;
    if (!(await this.slack.find(tenantId))) throw new NotFoundException("Slack is not connected");
    await this.slackEvents.requestSync(tenantId);
    return { status: "queued" };
  }

  @Post("slack/test-message")
  async slackTestMessage(@Req() req: SessionRequest, @Body() body: unknown) {
    const { channel } = parseBody(slackTestBody, body);
    try {
      await this.slackSender.postToChannel(req.session!.tenantId, channel, { text: TEST_TEXT });
      return { ok: true };
    } catch (err) {
      throw asSlackBadRequest(err);
    }
  }

  @Delete("telegram")
  @HttpCode(204)
  async disconnectTelegram(@Req() req: SessionRequest) {
    if (!(await this.telegram.disconnect(req.session!.tenantId))) throw new NotFoundException();
  }

  @Post("telegram/test-message")
  async telegramTestMessage(@Req() req: SessionRequest, @Body() body: unknown) {
    const { chatId } = parseBody(telegramTestBody, body);
    try {
      await this.telegramSender.send(req.session!.tenantId, chatId, {
        text: TEST_TEXT,
        buttons: [],
      });
      return { ok: true };
    } catch (err) {
      throw asTelegramBadRequest(err);
    }
  }

  @Get("telegram/chats")
  telegramChatList(@Req() req: SessionRequest) {
    return this.telegramChats.list(req.session!.tenantId);
  }

  /**
   * The "Getting started" checklist. Every step is read from the current state, so steps done
   * through the operator API or before an upgrade show as done.
   */
  @Get("onboarding")
  async onboarding(@Req() req: SessionRequest) {
    const { tenantId, personId } = req.session!;
    const tenant = (await this.tenants.findById(tenantId))!;
    const configRepo = configRepoOf(tenant);
    const [slack, telegram, active, latest, [delivered]] = await Promise.all([
      this.slack.find(tenantId),
      this.telegram.find(tenantId),
      this.configs.getActive(tenantId),
      this.configs.latest(tenantId),
      this.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(and(eq(deliveries.tenantId, tenantId), eq(deliveries.status, "sent")))
        .limit(1),
    ]);
    const steps = {
      githubApp: {
        done: true,
        org: tenant.githubOrgLogin,
        installationId: tenant.githubInstallationId,
      },
      slack: { done: Boolean(slack), team: slack?.teamName ?? null },
      linkGithub: { done: personId !== null },
      telegram: { done: Boolean(telegram), optional: true, bot: telegram?.botUsername ?? null },
      config: {
        done: Boolean(active),
        repo: `${configRepo.owner}/${configRepo.repo}`,
        rejected: latest?.status === "invalid",
        /** The first problems of a rejected push; all of them are on its Config page. */
        errors: latest?.status === "invalid" ? issuesOf(latest).errors.slice(0, 3) : [],
      },
      firstNotification: { done: delivered !== undefined },
    };
    return {
      steps,
      complete: Object.values(steps).every((s) => s.done || ("optional" in s && s.optional)),
    };
  }

  /**
   * What needs an admin's attention, most urgent first, plus a few counters. Each item is
   * read from the current state, so it disappears once the problem is gone.
   */
  @Get("attention")
  async attention(@Req() req: SessionRequest) {
    const { tenantId } = req.session!;
    const [active, latest, slack, counts, [unmapped], [suggested], [people]] = await Promise.all([
      this.configs.getActive(tenantId),
      this.configs.latest(tenantId),
      this.slack.find(tenantId),
      this.db
        .select({ status: notifications.status, count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            sql`${notifications.createdAt} > now() - interval '24 hours'`,
          ),
        )
        .groupBy(notifications.status),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(unmappedRecipients)
        .where(eq(unmappedRecipients.tenantId, tenantId)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(identities)
        .where(and(eq(identities.tenantId, tenantId), eq(identities.confidence, "suggested"))),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(persons)
        .where(and(eq(persons.tenantId, tenantId), eq(persons.status, "active"))),
    ]);
    const last24h = Object.fromEntries(counts.map((c) => [c.status, c.count]));
    const items: AttentionItem[] = [];
    if (latest?.status === "invalid") {
      items.push({
        kind: "config_rejected",
        versionId: latest.id,
        errors: issuesOf(latest).errors.length,
      });
    } else if (!active) {
      items.push({ kind: "no_config" });
    }
    if (!slack) items.push({ kind: "slack_missing" });
    for (const status of ["failed", "partially_failed"] as const) {
      if (last24h[status]) items.push({ kind: status, count: last24h[status] });
    }
    if (unmapped!.count) items.push({ kind: "unmapped", count: unmapped!.count });
    if (suggested!.count) items.push({ kind: "suggested", count: suggested!.count });
    const lastSync = slack?.lastSyncedAt;
    if (slack && (!lastSync || Date.now() - lastSync.getTime() > STALE_SYNC_MS)) {
      items.push({ kind: "sync_stale", lastSyncedAt: lastSync?.toISOString() ?? null });
    }
    return {
      items,
      counters: {
        routes: active ? Object.keys(active.config.routes).length : 0,
        people: people!.count,
        notifications24h: counts.reduce((sum, c) => sum + c.count, 0),
        delivered24h: last24h.delivered ?? 0,
      },
    };
  }

  @Get("status")
  async status(@Req() req: SessionRequest) {
    const { tenantId } = req.session!;
    const tenant = (await this.tenants.findById(tenantId))!;
    const { owner, repo } = configRepoOf(tenant);
    const [active, latest, slack, telegram] = await Promise.all([
      this.configs.getActive(tenantId),
      this.configs.latest(tenantId),
      this.slack.find(tenantId),
      this.telegram.find(tenantId),
    ]);
    return {
      tenantId,
      org: tenant.githubOrgLogin,
      installationId: tenant.githubInstallationId,
      configRepo: `${owner}/${repo}`,
      config: {
        active: active
          ? { commitSha: active.commitSha, routes: Object.keys(active.config.routes).length }
          : null,
        latest: latest
          ? {
              commitSha: latest.commitSha,
              status: latest.status,
              createdAt: latest.createdAt,
            }
          : null,
      },
      slack: slack
        ? {
            team: slack.teamName,
            commands: Boolean(slack.appTokenEncrypted),
            lastSyncedAt: slack.lastSyncedAt,
          }
        : null,
      telegram: telegram ? { bot: telegram.botUsername } : null,
    };
  }

  /** Every loaded push of the config repo, newest first; `before` pages backwards. */
  @Get("config/versions")
  async configVersionList(@Req() req: SessionRequest, @Query() query: unknown) {
    const { tenantId } = req.session!;
    const { before } = parseBody(versionsQuery, query);
    const [rows, active] = await Promise.all([
      this.db
        .select({
          id: configVersions.id,
          commitSha: configVersions.commitSha,
          status: configVersions.status,
          createdAt: configVersions.createdAt,
          errors: sql<number>`coalesce(jsonb_array_length(${configVersions.errors}->'errors'), 0)::int`,
          routes: sql<number>`(select count(*) from jsonb_object_keys(coalesce(${configVersions.config}->'routes', '{}'::jsonb)))::int`,
        })
        .from(configVersions)
        .where(
          and(
            eq(configVersions.tenantId, tenantId),
            before ? lt(configVersions.createdAt, new Date(before)) : undefined,
          ),
        )
        .orderBy(desc(configVersions.createdAt))
        .limit(PAGE),
      this.configs.getActive(tenantId),
    ]);
    return {
      items: rows.map((r) => ({ ...r, active: r.id === active?.versionId })),
      nextBefore: rows.length === PAGE ? rows.at(-1)!.createdAt.toISOString() : null,
    };
  }

  /** A version's problems, and the push before it for a GitHub compare link. */
  @Get("config/versions/:id")
  async configVersion(@Req() req: SessionRequest, @Param("id", ParseUUIDPipe) id: string) {
    const { tenantId } = req.session!;
    const [[version], active] = await Promise.all([
      this.db
        .select({
          id: configVersions.id,
          commitSha: configVersions.commitSha,
          status: configVersions.status,
          createdAt: configVersions.createdAt,
          errors: configVersions.errors,
          routes: sql<
            string[]
          >`coalesce((select array_agg(k) from jsonb_object_keys(${configVersions.config}->'routes') k), '{}')`,
          previousCommitSha: sql<string | null>`(
            select p.commit_sha from config_versions p
            where p.tenant_id = config_versions.tenant_id
              and p.created_at < config_versions.created_at
            order by p.created_at desc limit 1)`,
        })
        .from(configVersions)
        .where(and(eq(configVersions.tenantId, tenantId), eq(configVersions.id, id))),
      this.configs.getActive(tenantId),
    ]);
    if (!version) throw new NotFoundException();
    return {
      ...version,
      ...issuesOf(version),
      active: version.id === active?.versionId,
    };
  }

  /** When each maintenance task last ran from here, and what it did. */
  @Get("maintenance")
  async maintenance(@Req() req: SessionRequest) {
    const latest = await this.audit.latest(req.session!.tenantId, Object.values(MAINTENANCE));
    return {
      sync: latest.get(MAINTENANCE.sync) ?? null,
      retention: latest.get(MAINTENANCE.retention) ?? null,
    };
  }

  /** Queues the Slack and GitHub people syncs of this workspace, like the hourly job. */
  @Post("maintenance/sync")
  @HttpCode(202)
  async syncPeople(@Req() req: SessionRequest) {
    const { tenantId, personId, githubLogin } = req.session!;
    await this.lifecycle.syncTenant(tenantId);
    await this.audit.record({
      tenantId,
      action: MAINTENANCE.sync,
      actor: { personId, githubLogin },
    });
    return { status: "queued" };
  }

  /** Deletes this workspace's notifications and config versions past `retention_days` now. */
  @Post("maintenance/retention")
  async runRetention(@Req() req: SessionRequest) {
    const { tenantId, personId, githubLogin } = req.session!;
    const report = await this.retention.runTenant(tenantId);
    await this.audit.record({
      tenantId,
      action: MAINTENANCE.retention,
      actor: { personId, githubLogin },
      details: report,
    });
    return report;
  }

  @Post("config/reload")
  reload(@Req() req: SessionRequest) {
    return this.loader.load(req.session!.tenantId);
  }

  private async githubLoginOf(tenantId: string, personId: string): Promise<string | undefined> {
    const [account] = await this.db
      .select({ handle: identities.handle })
      .from(identities)
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.personId, personId),
          eq(identities.provider, "github"),
          inArray(identities.confidence, [...USABLE_CONFIDENCE]),
        ),
      )
      .limit(1);
    return account?.handle ?? undefined;
  }

  private async githubUser(
    tenantId: string,
    login: string,
  ): Promise<{ id: number; login: string }> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant?.githubInstallationId) throw new BadRequestException("GitHub App is not installed");
    const octokit = await this.githubApp.installationOctokit(tenant.githubInstallationId);
    try {
      const { data } = await octokit.request("GET /users/{username}", { username: login });
      return { id: Number(data.id), login: data.login };
    } catch (err) {
      if ((err as { status?: number }).status === 404)
        throw new BadRequestException(`GitHub user "${login}" not found`);
      throw err;
    }
  }
}
