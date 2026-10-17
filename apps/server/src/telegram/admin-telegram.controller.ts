import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { parseBody } from "../admin/parse-body";
import { TelegramApiError } from "./telegram-api";
import { TelegramConnectionsService } from "./telegram-connections.service";
import { TelegramSender } from "./telegram-sender";

export const telegramConnectBody = z.object({
  botToken: z.string().regex(/^\d+:[\w-]+$/, "a BotFather token"),
});
const testBody = z.object({ chatId: z.string().min(1), text: z.string().min(1) });

@Controller("admin/tenants/:tenantId/telegram")
@UseGuards(AdminTokenGuard)
export class AdminTelegramController {
  constructor(
    private readonly connections: TelegramConnectionsService,
    private readonly sender: TelegramSender,
  ) {}

  @Put()
  async connect(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const { botToken } = parseBody(telegramConnectBody, body);
    try {
      const connection = await this.connections.connect(tenantId, botToken);
      return { botId: connection.botId, botUsername: connection.botUsername };
    } catch (err) {
      if (err instanceof TelegramApiError)
        throw new BadRequestException(`Telegram rejected the token: ${err.description}`);
      throw err;
    }
  }

  @Post("test-message")
  async test(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const { chatId, text } = parseBody(testBody, body);
    try {
      return await this.sender.send(tenantId, chatId, { text, buttons: [] });
    } catch (err) {
      if (err instanceof TelegramApiError)
        throw new BadRequestException(`Telegram error: ${err.description}`);
      throw err;
    }
  }
}
