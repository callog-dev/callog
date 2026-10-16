import {
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { GithubIdentitySync, type GithubSyncReport } from "./github-identity-sync";

@Controller("admin/tenants/:tenantId/github")
@UseGuards(AdminTokenGuard)
export class AdminIdentityController {
  constructor(private readonly githubSync: GithubIdentitySync) {}

  /** Runs the GitHub identity sync now and returns the coverage report. */
  @Post("sync")
  async sync(@Param("tenantId", ParseUUIDPipe) tenantId: string): Promise<GithubSyncReport> {
    const report = await this.githubSync.sync(tenantId);
    if (!report) throw new NotFoundException("Tenant is not active");
    return report;
  }
}
