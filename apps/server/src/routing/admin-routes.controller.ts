import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ownValue } from "@callog/config-schema";
import { renderSlack, TemplateRenderError } from "@callog/templates";
import { z } from "zod";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { parseBody } from "../admin/parse-body";
import { SlackApiError } from "../slack/slack-api";
import { SlackSender } from "../slack/slack-sender";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { RecipientResolver } from "./recipient-resolver";

const testBody = z.object({
  /** Slack channel to post to (`#name` or id). */
  channel: z.string().min(1),
  /** Which entry of the route's `examples` to use. */
  example: z.number().int().min(0).default(0),
});

/**
 * Renders a route example with real recipient resolution and posts it to Slack:
 * an operator's end-to-end check of config + identities + templates.
 */
@Controller("admin/tenants/:tenantId/routes/:routeId")
@UseGuards(AdminTokenGuard)
export class AdminRoutesController {
  constructor(
    private readonly configs: TenantConfigService,
    private readonly resolver: RecipientResolver,
    private readonly slack: SlackSender,
  ) {}

  @Post("test")
  async test(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("routeId") routeId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(testBody, body);
    const config = (await this.configs.getActive(tenantId))?.config;
    const route = config && ownValue(config.routes, routeId);
    if (!config || !route)
      throw new NotFoundException(`Route "${routeId}" is not in the active config`);
    const example = route.examples[input.example] ?? { data: {}, recipients: [] };

    const resolution = await this.resolver.resolve(tenantId, config, example.recipients, "slack");
    let rendered;
    try {
      rendered = renderSlack(route, example, { mention: resolution.mention });
    } catch (err) {
      if (err instanceof TemplateRenderError) throw new BadRequestException(err.message);
      throw err;
    }
    await this.resolver.recordUnmapped(
      tenantId,
      rendered.unmapped,
      "slack",
      routeId,
      resolution.reasons,
    );
    try {
      const posted = await this.slack.postToChannel(tenantId, input.channel, rendered.message);
      return { posted, unmapped: rendered.unmapped };
    } catch (err) {
      if (err instanceof SlackApiError) throw new BadRequestException(`Slack error: ${err.code}`);
      throw err;
    }
  }
}
