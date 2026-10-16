import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { ConfigLoader, type LoadResult } from "./config-loader";
import { TenantConfigService } from "./tenant-config.service";

@Controller("admin/tenants/:tenantId/config")
@UseGuards(AdminTokenGuard)
export class AdminConfigController {
  constructor(
    private readonly loader: ConfigLoader,
    private readonly configs: TenantConfigService,
  ) {}

  /** Loads the config repo HEAD synchronously and returns the outcome. */
  @Post("reload")
  reload(@Param("tenantId", ParseUUIDPipe) tenantId: string): Promise<LoadResult> {
    return this.loader.load(tenantId);
  }

  @Get()
  async status(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    const [active, latest] = await Promise.all([
      this.configs.getActive(tenantId),
      this.configs.latest(tenantId),
    ]);
    if (!latest) throw new NotFoundException("No config loaded for this tenant");
    return {
      active: active
        ? {
            versionId: active.versionId,
            commitSha: active.commitSha,
            routes: Object.keys(active.config.routes),
          }
        : null,
      latest: {
        versionId: latest.id,
        commitSha: latest.commitSha,
        status: latest.status,
        issues: latest.errors,
      },
    };
  }
}
