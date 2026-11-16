import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { parseBody } from "../admin/parse-body";
import { apiKeyBody, ApiKeysService } from "./api-keys.service";

@Controller("admin/tenants/:tenantId/api-keys")
@UseGuards(AdminTokenGuard)
export class AdminApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  /** The plaintext key is returned only in this response. */
  @Post()
  async create(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const { name, direct } = parseBody(apiKeyBody, body);
    const { key, info } = await this.apiKeys.create(tenantId, name, { direct });
    return { key, ...info };
  }

  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.apiKeys.list(tenantId);
  }

  @Delete(":name")
  @HttpCode(204)
  async revoke(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Param("name") name: string) {
    if (!(await this.apiKeys.revoke(tenantId, name))) throw new NotFoundException();
  }
}
