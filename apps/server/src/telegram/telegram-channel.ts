import { Injectable } from "@nestjs/common";
import type { Route } from "@callog/config-schema";
import {
  renderTelegram,
  type MentionResolver,
  type RenderInput,
  type TelegramMessage,
} from "@callog/templates";
import {
  MessageGoneError,
  type Channel,
  type ClassifiedError,
  type Destination,
  type MessageRef,
} from "../channels/channel";
import { TelegramApiError } from "./telegram-api";
import { TelegramSender } from "./telegram-sender";

@Injectable()
export class TelegramChannel implements Channel<"telegram", TelegramMessage> {
  readonly id = "telegram";

  constructor(private readonly sender: TelegramSender) {}

  /**
   * Telegram allows about 20 messages per minute in a group. Group and channel ids are
   * negative or @usernames; private chats are positive ids.
   */
  minIntervalMs(to: Destination): number {
    return to.id.startsWith("-") || to.id.startsWith("@") ? 3100 : 1100;
  }

  /** Raw Slack blocks cannot be shown in Telegram. */
  canRender(route: Route): boolean {
    return route.template !== undefined;
  }

  render(route: Route, input: RenderInput, mention: MentionResolver): TelegramMessage {
    return renderTelegram(route, input, { mention }).message;
  }

  async send(
    tenantId: string,
    to: Destination,
    message: TelegramMessage,
    replyTo?: MessageRef<"telegram">,
  ): Promise<MessageRef<"telegram">> {
    // A personal chat with a Telegram user has the user's id as its chat id.
    const sent = await this.sender.send(tenantId, to.id, message, {
      replyToMessageId: replyTo?.messageId,
    });
    return { provider: "telegram", chatId: sent.chatId, messageId: sent.messageId };
  }

  async edit(
    tenantId: string,
    ref: MessageRef<"telegram">,
    message: TelegramMessage,
  ): Promise<void> {
    try {
      await this.sender.edit(tenantId, ref.chatId, ref.messageId, message);
    } catch (err) {
      if (err instanceof TelegramApiError && /not found|can't be edited/i.test(err.description)) {
        throw new MessageGoneError(`${ref.chatId}/${ref.messageId}: ${err.description}`);
      }
      throw err;
    }
  }

  classifyError(err: unknown): ClassifiedError | undefined {
    if (!(err instanceof TelegramApiError)) return undefined;
    return {
      // 429 and server-side errors are worth retrying; 400/403 (bad chat, bot removed) are not.
      permanent: err.code !== 429 && err.code < 500,
      message: `telegram: ${err.description}`,
      retryAfterSeconds: err.retryAfter,
    };
  }
}
