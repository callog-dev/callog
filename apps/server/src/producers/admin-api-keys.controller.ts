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
import { z } from "zod";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { parseBody } from "../admin/parse-body";
import { apiKeyNameSchema, ApiKeysService } from "./api-keys.service";

const createBody = z.object({ name: apiKeyNameSchema });

@Controller("admin/tenants/:tenantId/api-keys")
@UseGuards(AdminTokenGuard)
export class AdminApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  /** The plaintext key is returned only in this response. */
  @Post()
  async create(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const { name } = parseBody(createBody, body);
    const { key, info } = await this.apiKeys.create(tenantId, name);
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
