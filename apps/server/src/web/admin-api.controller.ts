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
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { parseBody } from "../admin/parse-body";
import { DB, type Db } from "../db/db";
import {
  deliveries,
  identities,
  notifications,
  persons,
  unmappedRecipients,
  USABLE_CONFIDENCE,
} from "../db/schema";
import { GithubAppService } from "../github/github-app.service";
import { PeopleService } from "../identity/people.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TenantAdminsService } from "../identity/tenant-admins.service";
import { apiKeyNameSchema, ApiKeysService } from "../producers/api-keys.service";
import { slackConnectBody } from "../slack/admin-slack.controller";
import { SlackTokenRejectedError } from "../slack/slack-api";
import { SlackConnectionsService } from "../slack/slack-connections.service";
import { SlackEvents } from "../slack/slack-events";
import { telegramConnectBody } from "../telegram/admin-telegram.controller";
import { TelegramApiError } from "../telegram/telegram-api";
import { TelegramChatsService } from "../telegram/telegram-chats.service";
import { TelegramConnectionsService } from "../telegram/telegram-connections.service";
import { RecipientResolver } from "../routing/recipient-resolver";
import { ConfigLoader } from "../tenant-config/config-loader";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { configRepoOf, TenantsService } from "../tenants/tenants.service";
import { AdminCheck } from "./admin-check";
import { AdminSessionGuard } from "./admin-session.guard";
import type { SessionRequest } from "./session.guard";

const PAGE = 50;

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
  before: z.iso.datetime({ offset: true }).optional(),
});
const apiKeyBody = z.object({ name: apiKeyNameSchema });
const adminBody = z.object({ personId: z.uuid() });

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

  /** Latest notifications with their deliveries; `before` (ISO date) pages backwards. */
  @Get("notifications")
  async notifications(@Req() req: SessionRequest, @Query() query: unknown) {
    const { tenantId } = req.session!;
    const { status, route, before } = parseBody(notificationsQuery, query);
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
          eq(notifications.tenantId, tenantId),
          status ? eq(notifications.status, status) : undefined,
          route ? eq(notifications.routeId, route) : undefined,
          before ? lt(notifications.createdAt, new Date(before)) : undefined,
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

  // ---- People ----

  @Get("people")
  async peopleList(@Req() req: SessionRequest) {
    const { tenantId } = req.session!;
    const ps = await this.db
      .select()
      .from(persons)
      .where(eq(persons.tenantId, tenantId))
      .orderBy(persons.displayName);
    const ids = await this.db.select().from(identities).where(eq(identities.tenantId, tenantId));
    return ps.map((p) => ({
      id: p.id,
      name: p.displayName,
      status: p.status,
      identities: ids
        .filter((i) => i.personId === p.id)
        .map((i) => ({
          id: i.id,
          provider: i.provider,
          externalId: i.externalId,
          handle: i.handle,
          source: i.source,
          confidence: i.confidence,
        })),
    }));
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
        /** The first problems of a rejected push; the rest are in the Overview tab. */
        errors:
          latest?.status === "invalid"
            ? ((latest.errors as { errors?: ConfigIssue[] } | null)?.errors ?? []).slice(0, 3)
            : [],
      },
      firstNotification: { done: delivered !== undefined },
    };
    return {
      steps,
      complete: Object.values(steps).every((s) => s.done || ("optional" in s && s.optional)),
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
    const counts = await this.db
      .select({ status: notifications.status, count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          sql`${notifications.createdAt} > now() - interval '24 hours'`,
        ),
      )
      .groupBy(notifications.status);
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
              issues: latest.errors,
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
      last24h: Object.fromEntries(counts.map((c) => [c.status, c.count])),
    };
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
