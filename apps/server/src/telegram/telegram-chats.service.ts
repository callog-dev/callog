import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import { telegramChats } from "../db/schema";
import type { TelegramChat } from "./telegram-api";

/** Chats the tenant's bot is in, for picking a destination without hunting for its id. */
@Injectable()
export class TelegramChatsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async remember(tenantId: string, chat: TelegramChat): Promise<void> {
    const values = { title: chat.title ?? null, type: chat.type };
    await this.db
      .insert(telegramChats)
      .values({ tenantId, chatId: String(chat.id), ...values })
      .onConflictDoUpdate({
        target: [telegramChats.tenantId, telegramChats.chatId],
        set: { ...values, updatedAt: new Date() },
      });
  }

  async forget(tenantId: string, chatId: string): Promise<void> {
    await this.db
      .delete(telegramChats)
      .where(and(eq(telegramChats.tenantId, tenantId), eq(telegramChats.chatId, chatId)));
  }

  list(tenantId: string) {
    return this.db
      .select({
        chatId: telegramChats.chatId,
        title: telegramChats.title,
        type: telegramChats.type,
      })
      .from(telegramChats)
      .where(eq(telegramChats.tenantId, tenantId))
      .orderBy(asc(telegramChats.title));
  }
}
