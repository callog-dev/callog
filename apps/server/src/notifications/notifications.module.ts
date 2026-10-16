import { Module } from "@nestjs/common";
import { ProducersModule } from "../producers/producers.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { DataValidator } from "./data-validator";
import { NotificationsService } from "./notifications.service";
import { NotifyController } from "./notify.controller";

@Module({
  imports: [ProducersModule, TenantConfigModule],
  controllers: [NotifyController],
  providers: [NotificationsService, DataValidator],
  exports: [NotificationsService],
})
export class NotificationsModule {}
