import { Module } from "@nestjs/common";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AdminApiKeysController } from "./admin-api-keys.controller";
import { ApiKeysService } from "./api-keys.service";
import { githubActionsKeys, OIDC_KEY_RESOLVER } from "./github-oidc";
import { ProducerAuthService } from "./producer-auth.service";
import { WhoamiController } from "./whoami.controller";

@Module({
  imports: [TenantsModule, TenantConfigModule],
  controllers: [AdminApiKeysController, WhoamiController],
  providers: [
    ApiKeysService,
    ProducerAuthService,
    { provide: OIDC_KEY_RESOLVER, useFactory: githubActionsKeys },
  ],
  exports: [ProducerAuthService, ApiKeysService],
})
export class ProducersModule {}
