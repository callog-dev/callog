import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ENV, type Env } from "../config/env";
import { safeEqual } from "../crypto/digest";

/** Operator auth for `/admin/*` via `ADMIN_TOKEN` (the web UI uses sessions instead). */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.env.ADMIN_TOKEN) throw new NotFoundException();
    const header = context.switchToHttp().getRequest<FastifyRequest>().headers.authorization;
    if (!safeEqual(`Bearer ${this.env.ADMIN_TOKEN}`, header)) throw new UnauthorizedException();
    return true;
  }
}
