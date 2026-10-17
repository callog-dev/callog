import { Module } from "@nestjs/common";
import {
  createGithubAppConversionClient,
  GITHUB_APP_CONVERSION_CLIENT,
} from "./github-app-conversion";
import { GithubAppSetupController } from "./github-app-setup.controller";

@Module({
  controllers: [GithubAppSetupController],
  providers: [
    { provide: GITHUB_APP_CONVERSION_CLIENT, useFactory: createGithubAppConversionClient },
  ],
})
export class SetupModule {}
