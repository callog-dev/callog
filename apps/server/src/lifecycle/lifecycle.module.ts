import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { SlackModule } from "../slack/slack.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AdminLifecycleController } from "./admin-lifecycle.controller";
import { LifecycleJobs } from "./lifecycle.jobs";
import { RetentionService } from "./retention.service";

@Module({
  imports: [TenantsModule, TenantConfigModule, IdentityModule, SlackModule],
  controllers: [AdminLifecycleController],
  providers: [RetentionService, LifecycleJobs],
})
export class LifecycleModule {}
