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
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ownValue } from "@callog/config-schema";
import type { FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { parseBody } from "../admin/parse-body";
import { DB, type Db } from "../db/db";
import { identities, persons } from "../db/schema";
import { routeTargets } from "../delivery/destinations";
import { PreferencesService } from "../identity/preferences.service";
import { TelegramChatTitles } from "../telegram/telegram-chat-titles";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { configRepoOf, TenantsService } from "../tenants/tenants.service";
import { AdminCheck } from "./admin-check";
import { clearCookie, readCookie } from "./cookies";
import { SESSION_COOKIE, SessionsService } from "./sessions.service";
import { SessionGuard, type SessionRequest } from "./session.guard";

const dmBody = z.object({ channel: z.enum(["slack", "telegram"]) });

/** JSON API of the web UI. Everything is scoped to the logged-in person's tenant. */
@Controller("api")
export class ApiController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: SessionsService,
    private readonly tenants: TenantsService,
    private readonly configs: TenantConfigService,
    private readonly preferences: PreferencesService,
    private readonly adminCheck: AdminCheck,
    private readonly chatTitles: TelegramChatTitles,
  ) {}

  @Get("me")
  @UseGuards(SessionGuard)
  async me(@Req() req: SessionRequest) {
    const { tenantId, personId } = req.session!;
    const [person] = await this.db.select().from(persons).where(eq(persons.id, personId));
    const tenant = await this.tenants.findById(tenantId);
    const accounts = await this.db
      .select()
      .from(identities)
      .where(and(eq(identities.tenantId, tenantId), eq(identities.personId, personId)));
    return {
      person: { id: personId, name: person!.displayName },
      org: tenant!.githubOrgLogin,
      isAdmin: await this.adminCheck.isAdmin(tenantId, personId),
      identities: accounts
        .map((a) => ({
          provider: a.provider,
          externalId: a.externalId,
          handle: a.handle,
          source: a.source,
          confidence: a.confidence,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider)),
      preferences: await this.preferences.get(personId),
    };
  }

  @Get("routes")
  @UseGuards(SessionGuard)
  async routes(@Req() req: SessionRequest) {
    const { tenantId, personId } = req.session!;
    const tenant = (await this.tenants.findById(tenantId))!;
    const active = await this.configs.getActive(tenantId);
    const { owner, repo } = configRepoOf(tenant);
    const muted = new Set((await this.preferences.get(personId)).mutedRoutes);
    const routes = Object.values(active?.config.routes ?? {}).map((route) => ({
      route,
      targets: routeTargets(route, active!.config),
    }));
    // Telegram destinations are raw chat ids; show the chat title when the bot can see it.
    const titles = await this.chatTitles.titles(
      tenantId,
      routes.flatMap(({ targets }) =>
        targets.filter((t) => t.provider === "telegram").map((t) => t.destination),
      ),
    );
    return {
      configRepo: `${owner}/${repo}`,
      commitSha: active?.commitSha ?? null,
      routes: routes.map(({ route, targets }) => ({
        id: route.id,
        description: route.description ?? null,
        destinations: targets.map((t) => {
          const label = t.provider === "telegram" ? titles.get(t.destination) : undefined;
          return label ? { ...t, label } : t;
        }),
        dm: route.dm,
        mentions: route.mentions,
        allowedSources: route.allowed_sources,
        dataFields: Object.keys(
          (route.schema?.properties as Record<string, unknown> | undefined) ?? {},
        ),
        muted: muted.has(route.id),
        url: `https://github.com/${owner}/${repo}/blob/${active!.commitSha}/routes/${route.id}.yaml`,
      })),
    };
  }

  @Put("me/preferences/dm")
  @UseGuards(SessionGuard)
  async setDm(@Req() req: SessionRequest, @Body() body: unknown) {
    const { tenantId, personId } = req.session!;
    const { channel } = parseBody(dmBody, body);
    if (channel === "telegram") {
      const linked = await this.db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.personId, personId), eq(identities.provider, "telegram")));
      if (linked.length === 0)
        throw new BadRequestException("Link Telegram first: /notify link telegram in Slack");
    }
    await this.preferences.setDmChannel(tenantId, personId, channel);
    return this.preferences.get(personId);
  }

  @Put("me/mutes/:routeId")
  @UseGuards(SessionGuard)
  async mute(@Req() req: SessionRequest, @Param("routeId") routeId: string) {
    const { tenantId, personId } = req.session!;
    const routes = (await this.configs.getActive(tenantId))?.config.routes ?? {};
    if (!ownValue(routes, routeId)) throw new NotFoundException(`Route "${routeId}" not found`);
    await this.preferences.mute(tenantId, personId, routeId);
    return this.preferences.get(personId);
  }

  @Delete("me/mutes/:routeId")
  @UseGuards(SessionGuard)
  async unmute(@Req() req: SessionRequest, @Param("routeId") routeId: string) {
    await this.preferences.unmute(req.session!.personId, routeId);
    return this.preferences.get(req.session!.personId);
  }

  @Post("auth/logout")
  @HttpCode(204)
  async logout(
    @Req() req: SessionRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.sessions.destroy(readCookie(req.headers.cookie, SESSION_COOKIE));
    reply.header("set-cookie", clearCookie(SESSION_COOKIE, this.sessions.secureCookies));
  }
}
