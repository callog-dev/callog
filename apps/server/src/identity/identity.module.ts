import { Module } from "@nestjs/common";
import { TenantConfigModule } from "../tenant-config/tenant-config.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AccountLinkingService } from "./account-linking.service";
import { AdminIdentityController } from "./admin-identity.controller";
import { GithubIdentitySync } from "./github-identity-sync";
import { createGithubOAuthClient, GITHUB_OAUTH_CLIENT, GithubOAuthConfig } from "./github-oauth";
import { ENV, type Env } from "../config/env";
import { IdentityEvents } from "./identity-events";
import { LinkTokensService } from "./link-tokens.service";
import { PeopleService } from "./people.service";
import { PreferencesService } from "./preferences.service";
import { TenantAdminsService } from "./tenant-admins.service";

@Module({
  imports: [TenantsModule, TenantConfigModule],
  controllers: [AdminIdentityController],
  providers: [
    TenantAdminsService,
    PeopleService,
    GithubIdentitySync,
    IdentityEvents,
    LinkTokensService,
    AccountLinkingService,
    GithubOAuthConfig,
    PreferencesService,
    {
      provide: GITHUB_OAUTH_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) => createGithubOAuthClient(env),
    },
  ],
  exports: [
    TenantAdminsService,
    PeopleService,
    IdentityEvents,
    LinkTokensService,
    AccountLinkingService,
    GithubOAuthConfig,
    PreferencesService,
    GITHUB_OAUTH_CLIENT,
  ],
})
export class IdentityModule {}
