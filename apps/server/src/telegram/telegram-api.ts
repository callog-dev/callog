import type { TelegramMessage } from "@callog/templates";

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

/** The subset of Bot API updates the server reacts to. */
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: TelegramChat; from?: TelegramUser; text?: string };
  my_chat_member?: {
    chat: TelegramChat;
    old_chat_member: { status: string };
    new_chat_member: { status: string };
  };
}

export interface TelegramSent {
  chatId: string;
  messageId: number;
}

export interface TelegramSendOptions {
  replyToMessageId?: number;
}

/** Bot API surface used by the server; faked in tests. */
export interface TelegramApi {
  getMe(): Promise<{ id: number; username: string }>;
  sendMessage(
    chatId: string,
    message: TelegramMessage,
    options?: TelegramSendOptions,
  ): Promise<TelegramSent>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  editMessage(chatId: string, messageId: number, message: TelegramMessage): Promise<TelegramSent>;
  getChat(chatId: string, signal?: AbortSignal): Promise<TelegramChat>;
}

/** A Bot API error: HTTP-like `code`, Telegram's description, `retryAfter` on 429. */
export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram API error ${code}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export type TelegramApiFactory = (botToken: string) => TelegramApi;
export const TELEGRAM_API_FACTORY = Symbol("TELEGRAM_API_FACTORY");

/** A hung request must not hold a worker slot; long polls get their poll time on top. */
const REQUEST_TIMEOUT_MS = 15_000;

/** fetch-based client: the Bot API is plain JSON over HTTPS, no SDK needed. */
export const createTelegramApi: TelegramApiFactory = (token) => {
  const call = async <T>(
    method: string,
    body: unknown,
    signal?: AbortSignal,
    pollSeconds = 0,
  ): Promise<T> => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS + pollSeconds * 1000);
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!json.ok) {
      throw new TelegramApiError(
        json.error_code ?? res.status,
        json.description ?? "unknown error",
        json.parameters?.retry_after,
      );
    }
    return json.result as T;
  };
  return {
    getMe: () => call<{ id: number; username: string }>("getMe", {}),
    sendMessage: async (chatId, message, options = {}) => {
      const sent = await call<{ message_id: number; chat: { id: number } }>("sendMessage", {
        chat_id: chatId,
        text: message.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(message.buttons.length ? { reply_markup: { inline_keyboard: message.buttons } } : {}),
        ...(options.replyToMessageId
          ? {
              reply_parameters: {
                message_id: options.replyToMessageId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
      });
      return { chatId: String(sent.chat.id), messageId: sent.message_id };
    },
    editMessage: async (chatId, messageId, message) => {
      try {
        await call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: message.text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: message.buttons },
        });
      } catch (err) {
        // Re-sending identical content is not an error for us.
        if (!(
          err instanceof TelegramApiError && err.description.includes("message is not modified")
        ))
          throw err;
      }
      return { chatId, messageId };
    },
    getChat: (chatId, signal) => call<TelegramChat>("getChat", { chat_id: chatId }, signal),
    getUpdates: (offset, timeoutSec, signal) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSec, allowed_updates: ["message", "my_chat_member"] },
        signal,
        timeoutSec,
      ),
  };
};
