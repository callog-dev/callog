import { Module } from "@nestjs/common";
import { SlackChannel } from "../slack/slack-channel";
import { SlackModule } from "../slack/slack.module";
import { TelegramChannel } from "../telegram/telegram-channel";
import { TelegramModule } from "../telegram/telegram.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { ChannelRegistry } from "./channel-registry";
import { PlaceChecks } from "./place-checks";

/** The one place that knows which channels exist. */
@Module({
  imports: [SlackModule, TelegramModule, TenantConfigModule],
  providers: [
    {
      provide: ChannelRegistry,
      useFactory: (slack: SlackChannel, telegram: TelegramChannel) =>
        new ChannelRegistry([slack, telegram]),
      inject: [SlackChannel, TelegramChannel],
    },
    PlaceChecks,
  ],
  exports: [ChannelRegistry, PlaceChecks],
})
export class ChannelsModule {}
