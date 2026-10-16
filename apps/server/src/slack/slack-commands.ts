import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import { identities, persons, USABLE_CONFIDENCE } from "../db/schema";
import { GithubOAuthConfig } from "../identity/github-oauth";
import { LINK_TOKEN_TTL_MS, LinkTokensService } from "../identity/link-tokens.service";
import { PreferencesService } from "../identity/preferences.service";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { TelegramConnectionsService } from "../telegram/telegram-connections.service";

const HELP = [
  "*/notify* — your accounts in Callog",
  "• `/notify whoami` — accounts linked to you",
  "• `/notify link github` — link your GitHub account (also a personal one)",
  "• `/notify link telegram` — link Telegram to be mentioned there",
  "• `/notify prefs` — where personal copies go: `prefs dm slack|telegram`, `prefs mute <route>`, `prefs unmute <route>`",
].join("\n");

/**
 * `/notify …` in Slack. Replies are ephemeral mrkdwn. The Slack user is the
 * anchor: links are always made for the person behind the Slack account that asked.
 */
@Injectable()
export class SlackCommands {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: LinkTokensService,
    private readonly githubOAuth: GithubOAuthConfig,
    private readonly telegram: TelegramConnectionsService,
    private readonly preferences: PreferencesService,
    private readonly configs: TenantConfigService,
  ) {}

  async handle(tenantId: string, command: { userId: string; text: string }): Promise<string> {
    const [verb, arg, value] = command.text.trim().toLowerCase().split(/\s+/);
    if (!verb || verb === "help") return HELP;

    const person = await this.personOf(tenantId, command.userId);
    if (!person) {
      return "I don't know you yet — the Slack directory sync runs hourly. Try again later or ask an admin.";
    }
    if (verb === "whoami") return this.whoami(tenantId, person);
    if (verb === "link" && arg === "github") return this.linkGithub(tenantId, person.id);
    if (verb === "link" && arg === "telegram") return this.linkTelegram(tenantId, person.id);
    if (verb === "prefs") return this.prefs(tenantId, person.id, arg, value);
    return `Unknown command \`${command.text.trim()}\`.\n\n${HELP}`;
  }

  private async whoami(
    tenantId: string,
    person: { id: string; displayName: string },
  ): Promise<string> {
    const rows = await this.db
      .select()
      .from(identities)
      .where(and(eq(identities.tenantId, tenantId), eq(identities.personId, person.id)));
    const lines = rows
      .sort((a, b) => a.provider.localeCompare(b.provider))
      .map((r) => {
        const name = r.provider === "slack" ? `<@${r.externalId}>` : (r.handle ?? r.externalId);
        const note = r.confidence === "suggested" ? " _(suggested — waiting for an admin)_" : "";
        return `• *${r.provider}*: ${name} — ${r.confidence} via ${r.source}${note}`;
      });
    return [`*${person.displayName}*`, ...lines].join("\n");
  }

  private async linkGithub(tenantId: string, personId: string): Promise<string> {
    if (!this.githubOAuth.enabled) return "GitHub linking is not configured on this server yet.";
    const token = await this.tokens.issue(tenantId, personId, "github");
    return `<${this.githubOAuth.authorizeUrl(token)}|Link your GitHub account> — the link works once and expires in ${minutes()} minutes.`;
  }

  private async linkTelegram(tenantId: string, personId: string): Promise<string> {
    const connection = await this.telegram.find(tenantId);
    if (!connection) return "Telegram is not connected for this workspace yet.";
    const token = await this.tokens.issue(tenantId, personId, "telegram");
    return `<https://t.me/${connection.botUsername}?start=${token}|Open @${connection.botUsername} in Telegram> and press *Start* — the link works once and expires in ${minutes()} minutes.`;
  }

  private async prefs(
    tenantId: string,
    personId: string,
    action?: string,
    value?: string,
  ): Promise<string> {
    if (action === "dm" && (value === "slack" || value === "telegram")) {
      if (value === "telegram" && !(await this.hasTelegram(tenantId, personId))) {
        return "Link Telegram first: `/notify link telegram`.";
      }
      await this.preferences.setDmChannel(tenantId, personId, value);
      return `Personal copies will go to *${value === "slack" ? "Slack" : "Telegram"}*.`;
    }
    if ((action === "mute" || action === "unmute") && value) {
      const routes = Object.keys((await this.configs.getActive(tenantId))?.config.routes ?? {});
      if (!routes.includes(value)) {
        return `No route \`${value}\`. Routes: ${routes.map((r) => `\`${r}\``).join(", ") || "none"}.`;
      }
      if (action === "mute") await this.preferences.mute(tenantId, personId, value);
      else await this.preferences.unmute(personId, value);
      return action === "mute"
        ? `Muted personal copies of \`${value}\`. You are still mentioned in its channels.`
        : `Unmuted \`${value}\`.`;
    }
    if (action)
      return "Usage: `/notify prefs dm slack|telegram`, `/notify prefs mute <route>`, `/notify prefs unmute <route>`.";

    const prefs = await this.preferences.get(personId);
    return [
      `*Personal copies* (routes with \`dm: true\`) go to *${prefs.dmChannel === "slack" ? "Slack" : "Telegram"}*.`,
      prefs.mutedRoutes.length
        ? `*Muted:* ${prefs.mutedRoutes.map((r) => `\`${r}\``).join(", ")}`
        : "*Muted:* nothing",
    ].join("\n");
  }

  private async hasTelegram(tenantId: string, personId: string) {
    const rows = await this.db
      .select({ id: identities.id })
      .from(identities)
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.personId, personId),
          eq(identities.provider, "telegram"),
          inArray(identities.confidence, [...USABLE_CONFIDENCE]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async personOf(tenantId: string, slackUserId: string) {
    const [row] = await this.db
      .select({ id: persons.id, displayName: persons.displayName })
      .from(identities)
      .innerJoin(persons, eq(persons.id, identities.personId))
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.provider, "slack"),
          eq(identities.externalId, slackUserId),
          eq(persons.status, "active"),
        ),
      );
    return row;
  }
}

const minutes = () => LINK_TOKEN_TTL_MS / 60_000;
