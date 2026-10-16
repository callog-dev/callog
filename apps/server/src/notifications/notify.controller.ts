import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
  type RawBodyRequest,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ProducerAuthService } from "../producers/producer-auth.service";
import { NotificationsService } from "./notifications.service";
import { MAX_BODY_BYTES, notifyRequestSchema } from "./notify-request";

/** Producer API. */
@Controller("v1")
export class NotifyController {
  constructor(
    private readonly auth: ProducerAuthService,
    private readonly notifications: NotificationsService,
  ) {}

  @Post("notify")
  @HttpCode(202)
  async notify(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    const producer = await this.auth.authenticate(authorization);

    const size = req.rawBody?.length ?? Buffer.byteLength(JSON.stringify(req.body ?? {}));
    if (size > MAX_BODY_BYTES) {
      throw new PayloadTooLargeException(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    if (
      idempotencyKey !== undefined &&
      (idempotencyKey.length === 0 || idempotencyKey.length > 200)
    ) {
      throw new BadRequestException("Idempotency-Key must be 1-200 characters");
    }
    const parsed = notifyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: "Invalid request body",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const accepted = await this.notifications.accept(producer, parsed.data, idempotencyKey);
    if (accepted.replayed) reply.header("idempotent-replayed", "true");
    return { notification_id: accepted.notificationId, status: "accepted" };
  }

  @Get("notifications/:id")
  async get(
    @Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const producer = await this.auth.authenticate(authorization);
    return this.notifications.get(producer.tenantId, id);
  }
}
