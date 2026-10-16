import { Injectable, Logger } from "@nestjs/common";
import { AccountLinkingService } from "../identity/account-linking.service";
import { escapeTelegram } from "@callog/templates";
import type { TelegramApi, TelegramChat, TelegramUpdate } from "./telegram-api";

const CHATID_COMMAND = /^\/chatid(?:@(\w+))?\s*$/i;
const START_COMMAND = /^\/start(?:@(\w+))?(?:\s+([\w-]+))?\s*$/i;

/**
 * Reacts to updates from the bot's chats: `/chatid` and a greeting with the id when the bot
 * is added to a group, so admins can put the chat id into the config, and
 * account linking via `/start <token>` in a private chat.
 */
@Injectable()
export class TelegramUpdates {
  private readonly logger = new Logger(TelegramUpdates.name);

  constructor(private readonly linking: AccountLinkingService) {}

  /** `botUsername`: commands addressed to another bot (`/chatid@other_bot`) are ignored. */
  async handle(
    tenantId: string,
    api: TelegramApi,
    update: TelegramUpdate,
    botUsername: string,
  ): Promise<void> {
    const text = update.message?.text?.trim();
    const forUs = (match: RegExpExecArray | null) =>
      match && (!match[1] || match[1].toLowerCase() === botUsername.toLowerCase());
    if (update.message && text && forUs(CHATID_COMMAND.exec(text))) {
      await this.sendChatId(api, update.message.chat, update.message.message_id);
      return;
    }
    const start = text ? START_COMMAND.exec(text) : null;
    if (update.message && start && forUs(start) && update.message.chat.type === "private") {
      const chatId = String(update.message.chat.id);
      const linkToken = start[2];
      if (linkToken && update.message.from) {
        await this.link(tenantId, api, chatId, linkToken, update.message.from);
        return;
      }
      await api.sendMessage(chatId, {
        text: "Hi! I deliver engineering notifications from Callog.\nAdd me to a group and send /chatid there to get its id for the config.",
        buttons: [],
      });
      return;
    }
    const member = update.my_chat_member;
    if (
      member &&
      isGroup(member.chat) &&
      joined(member.old_chat_member.status, member.new_chat_member.status)
    ) {
      this.logger.log(
        `Bot added to "${member.chat.title}" (${member.chat.id}) for tenant ${tenantId}`,
      );
      await this.sendChatId(api, member.chat);
    }
  }

  /** Deep-link `t.me/<bot>?start=<token>` from `/notify link telegram` in Slack. */
  private async link(
    tenantId: string,
    api: TelegramApi,
    chatId: string,
    token: string,
    from: { id: number; username?: string },
  ): Promise<void> {
    const outcome = await this.linking.complete(
      "telegram",
      token,
      { externalId: String(from.id), handle: from.username },
      tenantId,
    );
    const text = outcome.ok
      ? `✅ Linked this Telegram account to <b>${escapeTelegram(outcome.personName)}</b>. Mentions will reach you here.`
      : outcome.reason === "invalid_token"
        ? "This link is invalid or expired. Run <code>/notify link telegram</code> in Slack again."
        : "This Telegram account is already linked to someone else. Ask an admin to fix it.";
    await api.sendMessage(chatId, { text, buttons: [] });
  }

  private async sendChatId(api: TelegramApi, chat: TelegramChat, replyTo?: number): Promise<void> {
    const id = String(chat.id);
    const where = chat.title ? ` «${escapeTelegram(chat.title)}»` : "";
    await api.sendMessage(
      id,
      {
        text:
          `Chat id${where}: <code>${id}</code>\n\n` +
          `Use it as a destination in the config repo:\n<code>destinations: [{ telegram: "${id}" }]</code>`,
        buttons: [],
      },
      { replyToMessageId: replyTo },
    );
  }
}

function isGroup(chat: TelegramChat): boolean {
  return chat.type === "group" || chat.type === "supergroup" || chat.type === "channel";
}

function joined(oldStatus: string, newStatus: string): boolean {
  const out = ["left", "kicked"];
  const inside = ["member", "administrator", "creator"];
  return out.includes(oldStatus) && inside.includes(newStatus);
}
