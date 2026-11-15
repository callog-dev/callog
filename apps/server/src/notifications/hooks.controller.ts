import { Controller, HttpCode, Param, Post, Req, type RawBodyRequest } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ProducerAuthService } from "../producers/producer-auth.service";
import { NotificationsService } from "./notifications.service";
import { assertBodySize, parseNotifyRequest } from "./notify-request";

/**
 * Inbound webhooks. The token in the URL is the credential and names the route; the body
 * is any JSON object and becomes the notification's `data`. Who is notified is up to the
 * route.
 */
@Controller("v1/hooks")
export class HooksController {
  constructor(
    private readonly auth: ProducerAuthService,
    private readonly notifications: NotificationsService,
  ) {}

  @Post(":token")
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest<FastifyRequest>, @Param("token") token: string) {
    const { producer, routeId } = await this.auth.authenticateHook(token);

    assertBodySize(req);
    const request = parseNotifyRequest({ route: routeId, data: req.body ?? {} });

    const accepted = await this.notifications.accept(producer, request);
    return { notification_id: accepted.notificationId, status: "accepted" };
  }
}
