import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import { AppAccessService } from "./app-access.service";
import { GITHUB_APP_CONFIG, loadGithubAppConfig } from "./github.config";
import { GithubAppService } from "./github-app.service";
import { GithubWebhookController } from "./github-webhook.controller";
import { GithubWebhooksService } from "./github-webhooks.service";

@Global()
@Module({
  controllers: [GithubWebhookController],
  providers: [
    {
      provide: GITHUB_APP_CONFIG,
      inject: [ENV],
      useFactory: (env: Env) => loadGithubAppConfig(env),
    },
    GithubAppService,
    AppAccessService,
    GithubWebhooksService,
  ],
  exports: [GITHUB_APP_CONFIG, GithubAppService, AppAccessService, GithubWebhooksService],
})
export class GithubModule {}
