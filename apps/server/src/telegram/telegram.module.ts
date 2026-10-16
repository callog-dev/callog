import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { AdminTelegramController } from "./admin-telegram.controller";
import { createTelegramApi, TELEGRAM_API_FACTORY } from "./telegram-api";
import { TelegramChatTitles } from "./telegram-chat-titles";
import { TelegramConnectionsService } from "./telegram-connections.service";
import { TelegramPoller } from "./telegram-poller";
import { TelegramSender } from "./telegram-sender";
import { TelegramUpdates } from "./telegram-updates";

@Module({
  imports: [IdentityModule],
  controllers: [AdminTelegramController],
  providers: [
    { provide: TELEGRAM_API_FACTORY, useValue: createTelegramApi },
    TelegramConnectionsService,
    TelegramChatTitles,
    TelegramSender,
    TelegramUpdates,
    TelegramPoller,
  ],
  exports: [TelegramConnectionsService, TelegramChatTitles, TelegramSender],
})
export class TelegramModule {}
