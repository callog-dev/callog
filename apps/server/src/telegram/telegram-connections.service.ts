import { ConflictException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { SECRET_BOX } from "../crypto/crypto.module";
import type { SecretBox } from "../crypto/secret-box";
import { DB, type Db } from "../db/db";
import { telegramChats, telegramConnections } from "../db/schema";
import { TELEGRAM_API_FACTORY, type TelegramApi, type TelegramApiFactory } from "./telegram-api";

export type TelegramConnection = typeof telegramConnections.$inferSelect;

@Injectable()
export class TelegramConnectionsService {
  private readonly clients = new Map<string, { sealed: string; api: TelegramApi }>();
  private readonly changeListeners: (() => void)[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SECRET_BOX) private readonly secrets: SecretBox | undefined,
    @Inject(TELEGRAM_API_FACTORY) private readonly createApi: TelegramApiFactory,
  ) {}

  /** Lets the poller start or stop at once when a bot is connected or disconnected here. */
  onChanged(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  /** Forgets the bot and the groups it was in. False if no bot was connected. */
  async disconnect(tenantId: string): Promise<boolean> {
    const removed = await this.db.transaction(async (tx) => {
      await tx.delete(telegramChats).where(eq(telegramChats.tenantId, tenantId));
      return tx
        .delete(telegramConnections)
        .where(eq(telegramConnections.tenantId, tenantId))
        .returning({ tenantId: telegramConnections.tenantId });
    });
    this.clients.delete(tenantId);
    if (removed.length === 0) return false;
    this.changed();
    return true;
  }

  async connect(tenantId: string, botToken: string): Promise<TelegramConnection> {
    if (!this.secrets) throw new ServiceUnavailableException("ENCRYPTION_KEY is not configured");
    const me = await this.createApi(botToken).getMe();
    const [taken] = await this.db
      .select({ tenantId: telegramConnections.tenantId })
      .from(telegramConnections)
      .where(
        and(
          eq(telegramConnections.botId, String(me.id)),
          ne(telegramConnections.tenantId, tenantId),
        ),
      );
    if (taken) {
      throw new ConflictException(`@${me.username} is already connected to another organization`);
    }
    const values = {
      botId: String(me.id),
      botUsername: me.username,
      botTokenEncrypted: this.secrets.encrypt(botToken),
    };
    const previous = await this.find(tenantId);
    const connection = await this.db.transaction(async (tx) => {
      // The chats were the old bot's: the new one is in none of them yet.
      if (previous && previous.botId !== values.botId) {
        await tx.delete(telegramChats).where(eq(telegramChats.tenantId, tenantId));
      }
      const [row] = await tx
        .insert(telegramConnections)
        .values({ tenantId, ...values })
        .onConflictDoUpdate({
          target: telegramConnections.tenantId,
          set: { ...values, lastUpdateId: 0 },
        })
        .returning();
      return row!;
    });
    this.clients.delete(tenantId);
    this.changed();
    return connection;
  }

  async find(tenantId: string): Promise<TelegramConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(telegramConnections)
      .where(eq(telegramConnections.tenantId, tenantId));
    return connection;
  }

  listAll(): Promise<TelegramConnection[]> {
    return this.db.select().from(telegramConnections);
  }

  async api(tenantId: string): Promise<TelegramApi | undefined> {
    const connection = await this.find(tenantId);
    if (!connection || !this.secrets) return undefined;
    const cached = this.clients.get(tenantId);
    if (cached?.sealed === connection.botTokenEncrypted) return cached.api;
    const api = this.createApi(this.secrets.decrypt(connection.botTokenEncrypted));
    this.clients.set(tenantId, { sealed: connection.botTokenEncrypted, api });
    return api;
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  async saveOffset(tenantId: string, lastUpdateId: number): Promise<void> {
    await this.db
      .update(telegramConnections)
      .set({ lastUpdateId })
      .where(eq(telegramConnections.tenantId, tenantId));
  }
}
