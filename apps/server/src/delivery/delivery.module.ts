import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { RoutingModule } from "../routing/routing.module";
import { SlackModule } from "../slack/slack.module";
import { TelegramModule } from "../telegram/telegram.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { DeliveryService } from "./delivery.service";
import { DeliveryWorker } from "./delivery.worker";
import { DESTINATION_RATE_LIMITER, DestinationRateLimiter } from "./rate-limiter";

@Module({
  imports: [TenantConfigModule, RoutingModule, SlackModule, TelegramModule, IdentityModule],
  providers: [
    DeliveryService,
    DeliveryWorker,
    { provide: DESTINATION_RATE_LIMITER, useFactory: () => new DestinationRateLimiter() },
  ],
})
export class DeliveryModule {}
