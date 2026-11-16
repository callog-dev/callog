import { Module } from "@nestjs/common";
import { ProducersModule } from "../producers/producers.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { DataValidator } from "./data-validator";
import { HooksController } from "./hooks.controller";
import { NotificationsService } from "./notifications.service";
import { NotifyController } from "./notify.controller";
import { TraceService } from "./trace.service";

@Module({
  imports: [ProducersModule, TenantConfigModule],
  controllers: [NotifyController, HooksController],
  providers: [NotificationsService, DataValidator, TraceService],
  exports: [NotificationsService, TraceService],
})
export class NotificationsModule {}
