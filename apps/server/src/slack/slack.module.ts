import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { TelegramModule } from "../telegram/telegram.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { AdminSlackController } from "./admin-slack.controller";
import { createSlackApi, SLACK_API_FACTORY } from "./slack-api";
import { SlackCommands } from "./slack-commands";
import { SlackConnectionsService } from "./slack-connections.service";
import { SlackEvents } from "./slack-events";
import { SlackSender } from "./slack-sender";
import { createSlackSocket, SLACK_SOCKET_FACTORY, SlackSocketRunner } from "./slack-socket";
import { SlackUsersSync } from "./slack-users-sync";

@Module({
  imports: [IdentityModule, TelegramModule, TenantConfigModule],
  controllers: [AdminSlackController],
  providers: [
    { provide: SLACK_API_FACTORY, useValue: createSlackApi },
    { provide: SLACK_SOCKET_FACTORY, useValue: createSlackSocket },
    SlackConnectionsService,
    SlackUsersSync,
    SlackSender,
    SlackEvents,
    SlackCommands,
    SlackSocketRunner,
  ],
  exports: [SlackConnectionsService, SlackSender, SlackEvents],
})
export class SlackModule {}
