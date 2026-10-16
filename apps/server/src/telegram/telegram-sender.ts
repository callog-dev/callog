import { Injectable } from "@nestjs/common";
import type { TelegramMessage } from "@callog/templates";
import { TelegramApiError, type TelegramSendOptions, type TelegramSent } from "./telegram-api";
import { TelegramConnectionsService } from "./telegram-connections.service";

@Injectable()
export class TelegramSender {
  constructor(private readonly connections: TelegramConnectionsService) {}

  async send(
    tenantId: string,
    chatId: string,
    message: TelegramMessage,
    options?: TelegramSendOptions,
  ): Promise<TelegramSent> {
    return (await this.requireApi(tenantId)).sendMessage(chatId, message, options);
  }

  async edit(
    tenantId: string,
    chatId: string,
    messageId: number,
    message: TelegramMessage,
  ): Promise<TelegramSent> {
    return (await this.requireApi(tenantId)).editMessage(chatId, messageId, message);
  }

  /** A 400, so delivery treats a missing connection as a permanent failure. */
  private async requireApi(tenantId: string) {
    const api = await this.connections.api(tenantId);
    if (!api) throw new TelegramApiError(400, "Telegram is not connected for this tenant");
    return api;
  }
}
