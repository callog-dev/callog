import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { CryptoModule } from "./crypto/crypto.module";
import { DbModule } from "./db/db.module";
import { DeliveryModule } from "./delivery/delivery.module";
import { GithubModule } from "./github/github.module";
import { HealthModule } from "./health/health.module";
import { LifecycleModule } from "./lifecycle/lifecycle.module";
import { MetricsModule } from "./metrics/metrics.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { ProducersModule } from "./producers/producers.module";
import { QueueModule } from "./queue/queue.module";
import { RoutingModule } from "./routing/routing.module";
import { SlackModule } from "./slack/slack.module";
import { TenantConfigModule } from "./tenant-config/tenant-config.module";
import { TenantsModule } from "./tenants/tenants.module";
import { spaControllers, webUiModule } from "./web/static";
import { WebModule } from "./web/web.module";

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    DbModule,
    QueueModule,
    MetricsModule,
    GithubModule,
    TenantsModule,
    TenantConfigModule,
    SlackModule,
    RoutingModule,
    ProducersModule,
    NotificationsModule,
    DeliveryModule,
    LifecycleModule,
    WebModule,
    ...webUiModule(),
    HealthModule,
  ],
  // Registered last: the catch-all must not shadow API routes.
  controllers: spaControllers(),
})
export class AppModule {}
