import { Module } from "@nestjs/common";
import { SlackModule } from "../slack/slack.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AdminRoutesController } from "./admin-routes.controller";
import { RecipientResolver } from "./recipient-resolver";

@Module({
  imports: [TenantsModule, TenantConfigModule, SlackModule],
  controllers: [AdminRoutesController],
  providers: [RecipientResolver],
  exports: [RecipientResolver],
})
export class RoutingModule {}
