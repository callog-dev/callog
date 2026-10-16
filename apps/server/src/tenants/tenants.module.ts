import { Module } from "@nestjs/common";
import { InstallationEvents } from "./installation-events";
import { TenantsService } from "./tenants.service";

@Module({
  providers: [TenantsService, InstallationEvents],
  exports: [TenantsService],
})
export class TenantsModule {}
