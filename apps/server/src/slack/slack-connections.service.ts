import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { SECRET_BOX } from "../crypto/crypto.module";
import type { SecretBox } from "../crypto/secret-box";
import { DB, type Db } from "../db/db";
import { slackConnections } from "../db/schema";
import { SLACK_API_FACTORY, type SlackApi, type SlackApiFactory } from "./slack-api";

export type SlackConnection = typeof slackConnections.$inferSelect;

@Injectable()
export class SlackConnectionsService {
  private readonly clients = new Map<string, { sealed: string; api: SlackApi }>();
  private readonly connectedListeners: ((connection: SlackConnection) => void)[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SECRET_BOX) private readonly secrets: SecretBox | undefined,
    @Inject(SLACK_API_FACTORY) private readonly createApi: SlackApiFactory,
  ) {}

  /** Validates the token with Slack and stores it for the tenant (no OAuth install yet). */
  async connect(tenantId: string, botToken: string, appToken?: string): Promise<SlackConnection> {
    const box = this.requireSecrets();
    const info = await this.createApi(botToken).authTest();
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
    for (const listener of this.connectedListeners) listener(connection!);
    return connection!;
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

  /** Lets the Socket Mode runner (re)connect when a workspace is connected. */
  onConnected(listener: (connection: SlackConnection) => void): void {
    this.connectedListeners.push(listener);
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
