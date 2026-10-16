import { Controller, Get, Headers, Inject, Res, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ENV, type Env } from "../config/env";
import { safeEqual } from "../crypto/digest";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  async scrape(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    if (this.env.METRICS_TOKEN && !safeEqual(`Bearer ${this.env.METRICS_TOKEN}`, authorization)) {
      throw new UnauthorizedException();
    }
    reply.header("content-type", this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
