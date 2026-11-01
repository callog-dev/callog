import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { SECRET_BOX } from "../crypto/crypto.module";
import type { SecretBox } from "../crypto/secret-box";
import { DB, type Db } from "../db/db";
import { slackConnections } from "../db/schema";
import {
  SLACK_API_FACTORY,
  SlackApiError,
  SlackTokenRejectedError,
  type SlackApi,
  type SlackApiFactory,
} from "./slack-api";

export type SlackConnection = typeof slackConnections.$inferSelect;

@Injectable()
export class SlackConnectionsService {
  private readonly clients = new Map<string, { sealed: string; api: SlackApi }>();
  private readonly changeListeners: (() => void)[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SECRET_BOX) private readonly secrets: SecretBox | undefined,
    @Inject(SLACK_API_FACTORY) private readonly createApi: SlackApiFactory,
  ) {}

  /**
   * Checks the tokens with Slack and stores them for the tenant (no OAuth install yet).
   * Throws `SlackTokenRejectedError` naming the token Slack refused.
   */
  async connect(tenantId: string, botToken: string, appToken?: string): Promise<SlackConnection> {
    const box = this.requireSecrets();
    const info = await rejectedAs("bot", this.createApi(botToken).authTest());
    if (appToken) await rejectedAs("app", this.createApi(appToken).checkAppToken());
    const values = {
      teamId: info.teamId,
      teamName: info.teamName,
      botUserId: info.botUserId,
      botTokenEncrypted: box.encrypt(botToken),
      appTokenEncrypted: appToken ? box.encrypt(appToken) : null,
    };
    const [connection] = await this.db
      .insert(slackConnections)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: slackConnections.tenantId, set: values })
      .returning();
    this.clients.delete(tenantId);
    this.changed();
    return connection!;
  }

  /** Forgets the workspace's tokens; people and their accounts stay. False if none was stored. */
  async disconnect(tenantId: string): Promise<boolean> {
    const removed = await this.db
      .delete(slackConnections)
      .where(eq(slackConnections.tenantId, tenantId))
      .returning({ tenantId: slackConnections.tenantId });
    this.clients.delete(tenantId);
    if (removed.length === 0) return false;
    this.changed();
    return true;
  }

  async findByTeam(teamId: string): Promise<SlackConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(slackConnections)
      .where(eq(slackConnections.teamId, teamId));
    return connection;
  }

  async find(tenantId: string): Promise<SlackConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(slackConnections)
      .where(eq(slackConnections.tenantId, tenantId));
    return connection;
  }

  /** Slack client for the tenant, or undefined when Slack is not connected. */
  async api(tenantId: string): Promise<SlackApi | undefined> {
    const connection = await this.find(tenantId);
    if (!connection) return undefined;
    const cached = this.clients.get(tenantId);
    if (cached?.sealed === connection.botTokenEncrypted) return cached.api;
    const api = this.createApi(this.requireSecrets().decrypt(connection.botTokenEncrypted));
    this.clients.set(tenantId, { sealed: connection.botTokenEncrypted, api });
    return api;
  }

  /**
   * Lets the Socket Mode runner open or close a socket at once when a workspace is connected
   * or disconnected here, instead of on its next reconcile.
   */
  onChanged(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  listAll(): Promise<SlackConnection[]> {
    return this.db.select().from(slackConnections);
  }

  appToken(connection: SlackConnection): string | undefined {
    return connection.appTokenEncrypted
      ? this.requireSecrets().decrypt(connection.appTokenEncrypted)
      : undefined;
  }

  async markSynced(tenantId: string): Promise<void> {
    await this.db
      .update(slackConnections)
      .set({ lastSyncedAt: new Date() })
      .where(eq(slackConnections.tenantId, tenantId));
  }

  private requireSecrets(): SecretBox {
    if (!this.secrets) throw new ServiceUnavailableException("ENCRYPTION_KEY is not configured");
    return this.secrets;
  }
}

async function rejectedAs<T>(token: "bot" | "app", call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof SlackApiError) throw new SlackTokenRejectedError(token, err.code);
    throw err;
  }
}
