import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminTokenGuard } from "../admin/admin-token.guard";
import { parseBody } from "../admin/parse-body";
import { SlackApiError, SlackTokenRejectedError } from "./slack-api";
import { SlackConnectionsService } from "./slack-connections.service";
import { SlackEvents } from "./slack-events";
import { SlackSender } from "./slack-sender";
import { SlackUsersSync } from "./slack-users-sync";

export const slackConnectBody = z.object({
  botToken: z.string().startsWith("xoxb-"),
  /** Enables /notify over Socket Mode (needs connections:write). */
  appToken: z.string().startsWith("xapp-").optional(),
});

const testMessageBody = z
  .object({
    channel: z.string().min(1).optional(),
    slackUserId: z.string().min(1).optional(),
    text: z.string().min(1),
  })
  .refine(
    (b) => Boolean(b.channel) !== Boolean(b.slackUserId),
    "exactly one of channel or slackUserId",
  );

/** Operator endpoints for connecting and checking Slack (there is no OAuth install flow). */
@Controller("admin/tenants/:tenantId/slack")
@UseGuards(AdminTokenGuard)
export class AdminSlackController {
  constructor(
    private readonly connections: SlackConnectionsService,
    private readonly usersSync: SlackUsersSync,
    private readonly events: SlackEvents,
    private readonly sender: SlackSender,
  ) {}

  @Put()
  async connect(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const { botToken, appToken } = parseBody(slackConnectBody, body);
    try {
      const connection = await this.connections.connect(tenantId, botToken, appToken);
      await this.events.requestSync(tenantId);
      return {
        teamId: connection.teamId,
        teamName: connection.teamName,
        botUserId: connection.botUserId,
      };
    } catch (err) {
      if (err instanceof SlackTokenRejectedError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Post("sync")
  async sync(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    const result = await this.usersSync.sync(tenantId);
    if (!result) throw new NotFoundException("Slack is not connected for this tenant");
    return result;
  }

  /** Plain text to a channel or DM; route rendering lives in `/routes/:routeId/test`. */
  @Post("test-message")
  async testMessage(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const input = parseBody(testMessageBody, body);
    try {
      return input.channel
        ? await this.sender.postToChannel(tenantId, input.channel, { text: input.text })
        : await this.sender.postDirect(tenantId, input.slackUserId!, { text: input.text });
    } catch (err) {
      if (err instanceof SlackApiError) throw new BadRequestException(`Slack error: ${err.code}`);
      throw err;
    }
  }
}
