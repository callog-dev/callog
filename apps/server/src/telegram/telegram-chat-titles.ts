import { Injectable, Logger } from "@nestjs/common";
import { setBounded } from "../common/bounded-map";
import { TelegramConnectionsService } from "./telegram-connections.service";

const TITLE_TTL_MS = 10 * 60_000;
/** Misses (unknown chat, Telegram down) are retried sooner. */
const MISS_TTL_MS = 60_000;
const GET_CHAT_TIMEOUT_MS = 3_000;
const MAX_CHATS = 10_000;

/** Human-readable Telegram chat titles for the web UI, cached in memory (getChat). */
@Injectable()
export class TelegramChatTitles {
  private readonly logger = new Logger(TelegramChatTitles.name);
  private readonly cache = new Map<
    string,
    { at: number; ttl: number; title: string | undefined }
  >();

  constructor(private readonly connections: TelegramConnectionsService) {}

  /** Titles by chat id; chats that cannot be resolved are left out. Never throws. */
  async titles(tenantId: string, chatIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const unique = [...new Set(chatIds)];
    if (unique.length === 0) return result;
    const api = await this.connections.api(tenantId).catch(() => undefined);
    if (!api) return result;
    await Promise.all(
      unique.map(async (chatId) => {
        const key = `${tenantId}\n${chatId}`;
        let hit = this.cache.get(key);
        if (!hit || Date.now() - hit.at >= hit.ttl) {
          try {
            const chat = await api.getChat(chatId, AbortSignal.timeout(GET_CHAT_TIMEOUT_MS));
            const title = chat.title ?? (chat.username ? `@${chat.username}` : undefined);
            hit = { at: Date.now(), ttl: TITLE_TTL_MS, title };
          } catch (err) {
            this.logger.warn(`getChat ${chatId} failed: ${(err as Error).message}`);
            hit = { at: Date.now(), ttl: MISS_TTL_MS, title: undefined };
          }
          setBounded(this.cache, key, hit, MAX_CHATS);
        }
        if (hit.title) result.set(chatId, hit.title);
      }),
    );
    return result;
  }
}
