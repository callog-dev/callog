import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
  type RawBodyRequest,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { GITHUB_APP_CONFIG, type GithubAppConfig } from "./github.config";
import { GithubWebhooksService } from "./github-webhooks.service";
import { verifyWebhookSignature } from "./webhook-signature";

@Controller("webhooks/github")
export class GithubWebhookController {
  constructor(
    @Inject(GITHUB_APP_CONFIG) private readonly config: GithubAppConfig | undefined,
    private readonly webhooks: GithubWebhooksService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers("x-github-event") event: string | undefined,
    @Headers("x-github-delivery") deliveryId: string | undefined,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ): Promise<{ handled: boolean }> {
    if (!this.config) throw new ServiceUnavailableException("GitHub App is not configured");
    if (
      !req.rawBody ||
      !verifyWebhookSignature(this.config.webhookSecret, req.rawBody, signature)
    ) {
      throw new UnauthorizedException("Invalid webhook signature");
    }
    if (!event || !deliveryId) throw new BadRequestException("Missing GitHub event headers");
    const handled = await this.webhooks.dispatch(event, req.body, deliveryId);
    return { handled };
  }
}
