import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module";
import { IdentityModule } from "../identity/identity.module";
import { RoutingModule } from "../routing/routing.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { DeliveryPlanner } from "./delivery-planner";
import { DeliveryService } from "./delivery.service";
import { DeliveryWorker } from "./delivery.worker";
import { PersonalCopies } from "./personal-copies";
import { DESTINATION_RATE_LIMITER, DestinationRateLimiter } from "./rate-limiter";

@Module({
  imports: [TenantConfigModule, RoutingModule, ChannelsModule, IdentityModule],
  providers: [
    DeliveryService,
    DeliveryPlanner,
    DeliveryWorker,
    PersonalCopies,
    { provide: DESTINATION_RATE_LIMITER, useFactory: () => new DestinationRateLimiter() },
  ],
  exports: [DeliveryPlanner],
})
export class DeliveryModule {}
