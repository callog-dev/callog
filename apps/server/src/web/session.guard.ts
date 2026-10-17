import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { readCookie } from "./cookies";
import { SESSION_COOKIE, SessionsService, type Session } from "./sessions.service";

export type SessionRequest = FastifyRequest & { session?: Session };

/** Requires a logged-in web user (an unlinked org owner too); puts the session on the request. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SessionRequest>();
    const session = await this.sessions.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!session) throw new UnauthorizedException("Not logged in");
    req.session = session;
    return true;
  }
}

/** Pages about the person themselves: an org owner signed in without a linked person has none. */
@Injectable()
export class PersonGuard implements CanActivate {
  constructor(private readonly sessions: SessionGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.sessions.canActivate(context);
    if (!context.switchToHttp().getRequest<SessionRequest>().session!.personId) {
      throw new ForbiddenException("Link your GitHub account first: /notify link github in Slack");
    }
    return true;
  }
}
