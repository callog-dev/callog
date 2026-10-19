import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProducersModule } from "../producers/producers.module";
import { RoutingModule } from "../routing/routing.module";
import { SlackModule } from "../slack/slack.module";
import { TelegramModule } from "../telegram/telegram.module";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AdminApiController } from "./admin-api.controller";
import { AdminCheck } from "./admin-check";
import { AdminSessionGuard } from "./admin-session.guard";
import { ApiController } from "./api.controller";
import { GithubOAuthController } from "./github-oauth.controller";
import { PersonGuard, SessionGuard } from "./session.guard";
import { SessionsService } from "./sessions.service";

@Module({
  imports: [
    IdentityModule,
    NotificationsModule,
    TenantsModule,
    TenantConfigModule,
    ProducersModule,
    RoutingModule,
    SlackModule,
    TelegramModule,
  ],
  controllers: [GithubOAuthController, ApiController, AdminApiController],
  providers: [SessionsService, SessionGuard, PersonGuard, AdminCheck, AdminSessionGuard],
})
export class WebModule {}
