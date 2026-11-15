import { Module } from "@nestjs/common";
import { SlackChannel } from "../slack/slack-channel";
import { SlackModule } from "../slack/slack.module";
import { TelegramChannel } from "../telegram/telegram-channel";
import { TelegramModule } from "../telegram/telegram.module";
import { ChannelRegistry } from "./channel-registry";

/** The one place that knows which channels exist. */
@Module({
  imports: [SlackModule, TelegramModule],
  providers: [
    {
      provide: ChannelRegistry,
      useFactory: (slack: SlackChannel, telegram: TelegramChannel) =>
        new ChannelRegistry([slack, telegram]),
      inject: [SlackChannel, TelegramChannel],
    },
  ],
  exports: [ChannelRegistry],
})
export class ChannelsModule {}
