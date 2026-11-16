import {
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { bearerToken, ProducerAuthService } from "../producers/producer-auth.service";
import { NotificationsService } from "./notifications.service";
import { assertBodySize, parseNotifyRequest } from "./notify-request";

/**
 * Inbound webhooks. The hook's token is the credential and names the route; the body is any
 * JSON object and becomes the notification's `data`. Who is notified is up to the route.
 *
 * The token comes in the `Authorization` header when the sender can set one, and in the URL
 * when it cannot: a URL ends up in the sender's settings and in access logs.
 */
@Controller("v1/hooks")
export class HooksController {
  constructor(
    private readonly auth: ProducerAuthService,
    private readonly notifications: NotificationsService,
  ) {}

  @Post()
  @HttpCode(202)
  fromHeader(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers("authorization") authorization: string | undefined,
  ) {
    return this.receive(req, bearerToken(authorization));
  }

  @Post(":token")
  @HttpCode(202)
  fromUrl(@Req() req: RawBodyRequest<FastifyRequest>, @Param("token") token: string) {
    return this.receive(req, token);
  }

  private async receive(req: RawBodyRequest<FastifyRequest>, token: string) {
    const { producer, routeId } = await this.auth.authenticateHook(token);

    assertBodySize(req);
    const request = parseNotifyRequest({ route: routeId, data: req.body ?? {} });

    const accepted = await this.notifications.accept(producer, request);
    return { notification_id: accepted.notificationId, status: "accepted" };
  }
}
