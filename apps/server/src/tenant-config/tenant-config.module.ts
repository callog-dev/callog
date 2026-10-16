import { Module } from "@nestjs/common";
import { TenantsModule } from "../tenants/tenants.module";
import { AdminConfigController } from "./admin-config.controller";
import { ConfigEvents } from "./config-events";
import { ConfigLoader } from "./config-loader";
import { TenantConfigService } from "./tenant-config.service";

@Module({
  imports: [TenantsModule],
  controllers: [AdminConfigController],
  providers: [TenantConfigService, ConfigLoader, ConfigEvents],
  exports: [TenantConfigService, ConfigLoader],
})
export class TenantConfigModule {}
