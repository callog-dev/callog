import type { TelegramMessage } from "@callog/templates";
import {
  TelegramApiError,
  type TelegramApi,
  type TelegramChat,
  type TelegramSendOptions,
  type TelegramUpdate,
} from "../../src/telegram/telegram-api";

export const GOOD_TELEGRAM_TOKEN = "123456:test-good-token";
/** A second valid bot (another tenant's). */
export const OTHER_TELEGRAM_TOKEN = "654321:test-other-token";
const BOTS: Record<string, { id: number; username: string }> = {
  [GOOD_TELEGRAM_TOKEN]: { id: 123456, username: "notify_test_bot" },
  [OTHER_TELEGRAM_TOKEN]: { id: 654321, username: "other_test_bot" },
};

/** In-memory Telegram Bot API. Only GOOD_TELEGRAM_TOKEN and OTHER_TELEGRAM_TOKEN are valid. */
export class FakeTelegram {
  sent: { chatId: string; message: TelegramMessage; options?: TelegramSendOptions }[] = [];
  failures: TelegramApiError[] = [];
  edited: { chatId: string; messageId: number; message: TelegramMessage }[] = [];
  /** Served by getUpdates (respecting offset). */
  updates: TelegramUpdate[] = [];
  getUpdatesOffsets: number[] = [];
  /** Simulates a bot token revoked in BotFather (getUpdates answers 401). */
  revoked = false;
  /** Served by getChat; unknown ids fail with "chat not found". */
  chats = new Map<string, TelegramChat>();
  getChatCalls: string[] = [];
  /** Simulates the Bot API being down for getChat. */
  getChatUnreachable = false;

  factory = (token: string): TelegramApi => {
    const check = () => {
      if (!BOTS[token]) throw new TelegramApiError(401, "Unauthorized");
    };
    return {
      getMe: async () => {
        check();
        return BOTS[token]!;
      },
      sendMessage: async (chatId, message, options) => {
        check();
        const failure = this.failures.shift();
        if (failure) throw failure;
        this.sent.push({ chatId, message, options });
        return { chatId, messageId: this.sent.length };
      },
      editMessage: async (chatId, messageId, message) => {
        check();
        this.edited.push({ chatId, messageId, message });
        return { chatId, messageId };
      },
      getChat: async (chatId) => {
        check();
        this.getChatCalls.push(chatId);
        if (this.getChatUnreachable) throw new TypeError("fetch failed");
        const chat = this.chats.get(chatId);
        if (!chat) throw new TelegramApiError(400, "Bad Request: chat not found");
        return chat;
      },
      getUpdates: async (offset, _timeout, signal) => {
        this.getUpdatesOffsets.push(offset);
        if (this.revoked) throw new TelegramApiError(401, "Unauthorized");
        check();
        const batch = this.updates.filter((u) => u.update_id >= offset);
        if (batch.length) return batch;
        // Long poll: wait a little (or until aborted) and return nothing.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return [];
      },
    };
  };
}
